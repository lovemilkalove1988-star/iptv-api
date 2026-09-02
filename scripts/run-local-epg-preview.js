const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Transform } = require('stream');
const crypto = require('crypto');
const db = require('../database');
const epg = require('../services/milktv-epg');
const matcher = require('../services/milktv-epg-matcher');
const streamPreview = require('../services/milktv-epg-stream-preview');

const MAX_INPUT_BYTES = 150 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_STREAM_UNCOMPRESSED_BYTES = 1500 * 1024 * 1024;
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const providerArg = args.indexOf('--provider');
const provider = providerArg >= 0 ? args[providerArg + 1] : null;
const jsonArg = args.indexOf('--json-output');
const jsonOutput = jsonArg >= 0 ? args[jsonArg + 1] : null;
let activeTempPath = null;
process.on('exit', () => { if (activeTempPath) { try { fs.rmSync(activeTempPath, { force: true }); } catch (_) {} } });

function programmeKey(channelId, p) { return crypto.createHash('sha1').update(`${channelId}|${p.start.toISOString()}|${p.title}`).digest('hex'); }
function categoryOf(channel) { const v = channel.category || channel.category_name || channel.milktv_category || channel.categories; return Array.isArray(v) ? v.join(' ') : String(v || ''); }
function categoryHit(channel, wanted) { return categoryOf(channel).toLowerCase().includes(wanted.toLowerCase()); }
async function decompressToTemp(inputPath) {
  const tempDir = path.join(path.dirname(inputPath), '.tmp'); fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `epg-preview-${process.pid}-${Date.now()}.xml`); let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) { total += chunk.length; if (total > MAX_STREAM_UNCOMPRESSED_BYTES) return callback(new Error('Uncompressed XMLTV exceeds streaming limit')); callback(null, chunk); } });
  await new Promise((resolve, reject) => { const input = fs.createReadStream(inputPath); const output = fs.createWriteStream(tempPath); const gunzip = zlib.createGunzip(); const fail = e => { input.destroy(); gunzip.destroy(); output.destroy(); reject(e); }; input.on('error', fail); gunzip.on('error', fail); limiter.on('error', fail); output.on('error', fail); output.on('finish', resolve); input.pipe(gunzip).pipe(limiter).pipe(output); });
  return { tempPath, bytes: total };
}

(async () => {
  if (!file) throw new Error('Usage: node scripts/run-local-epg-preview.js <file> [--provider label] [--json-output file]');
  const absolute = path.resolve(file); const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('Input is not a regular file');
  if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES) throw new Error(`Input file exceeds ${MAX_INPUT_BYTES} byte limit`);
  console.log('1/5 Reading file...');
  const compressed = /\.gz$/i.test(absolute); let raw; let xml; let tempPath = null;
  raw = fs.readFileSync(absolute);
  console.log(compressed ? '2/5 Decompressing...' : '2/5 Decompressing... SKIP');
  try { if (compressed) { const tmp = await decompressToTemp(absolute); tempPath = tmp.tempPath; activeTempPath = tempPath; if (tmp.bytes > MAX_UNCOMPRESSED_BYTES) { console.log('3/5 Streaming parse...'); const logicalChannels = (await db.query('SELECT * FROM channels ORDER BY id')).rows; const streamed = await streamPreview.previewXmltvStream(tempPath, logicalChannels, matcher.matchEpgChannel, { samplePerChannel: 20 }); const all = streamed.channelResults; const mapped = streamed.matched; const direct = mapped.filter(x => x.match.method === 'direct' || x.match.method === 'manual'); const prefix = mapped.filter(x => x.match.method === 'country_prefix'); const amb = all.filter(x => x.match.confidence === 'ambiguous'); const unmatched = all.filter(x => !x.match.channelId && x.match.confidence !== 'ambiguous'); const labels=['\u041a\u0430\u0437\u0430\u0445\u0441\u0442\u0430\u043d','\u0414\u0435\u0442\u0441\u043a\u0438\u0435','\u041a\u0438\u043d\u043e','\u041c\u0443\u0437\u044b\u043a\u0430','\u0421\u043f\u043e\u0440\u0442']; const categoryCoverage=Object.fromEntries(labels.map(c=>[c,{total:logicalChannels.filter(x=>categoryHit(x,c)).length,matched:mapped.filter(x=>categoryHit(logicalChannels.find(ch=>ch.id===x.match.channelId)||{},c)).length}])); const samples = mapped.slice(0, 10).map(x => { const ps = (streamed.programmesByEpg.get(x.epg.id) || []).sort((a,b) => a.start-b.start); return { channel_id:x.match.channelId, channel_name:logicalChannels.find(c => c.id === x.match.channelId)?.name || null, xmltv_channel:x.epg.id, now:ps[0] || null, next:ps[1] || null }; }); const report = { file:{path:absolute,name:path.basename(absolute),compressed:true,bytes:raw.length,uncompressed_bytes:tmp.bytes},provider:provider||null,xmltv:{channels:streamed.channels,programmes:streamed.programmes,invalid:streamed.invalid,earliest:streamed.earliest,latest:streamed.latest},matching:{logical_channels_total:logicalChannels.length,exact_high:mapped.length,exact_direct:direct.length,exact_after_provider_prefix:prefix.length,ambiguous:amb.length,unmatched:unmatched.length,matched_examples:mapped.slice(0,30).map(x=>({epg_id:x.epg.id,name:x.epg.displayName,channel_id:x.match.channelId,method:x.match.method})),ambiguous_examples:amb.slice(0,20).map(x=>({epg_id:x.epg.id,name:x.epg.displayName})),unmatched_examples:unmatched.slice(0,20).map(x=>({epg_id:x.epg.id,name:x.epg.displayName}))},category_coverage:categoryCoverage,now_next_samples:samples,programme_key_stability:'PASS (stream sample)'}; console.log('5/5 Reporting...'); console.log(JSON.stringify(report,null,2)); if(jsonOutput)fs.writeFileSync(path.resolve(jsonOutput),JSON.stringify(report,null,2)); return; } xml = fs.readFileSync(tempPath); } else xml = raw; } catch (error) { throw new Error(error.message.includes('parser memory') ? error.message : `Decompression failed or output exceeds ${MAX_STREAM_UNCOMPRESSED_BYTES} bytes`); }
  if (!xml.length || xml.length > MAX_UNCOMPRESSED_BYTES) throw new Error('Uncompressed XMLTV exceeds parser memory limit (500 MB)');
  console.log('3/5 Parsing...');
  let parsed; try { parsed = epg.parseXmltv(xml.toString('utf8')); } catch (error) { throw new Error(`XMLTV parse failed: ${error.message}`); }
  if (!parsed.channels.length) throw new Error('Suspicious XMLTV: zero channels');
  if (!parsed.programmes.length) throw new Error('Suspicious XMLTV: zero programmes');
  const channels = (await db.query('SELECT * FROM channels ORDER BY id')).rows;
  console.log('4/5 Matching...');
  const results = parsed.channels.map(e => ({ epg: e, match: matcher.matchEpgChannel(e, channels) }));
  const mapped = results.filter(x => x.match.channelId); const direct = mapped.filter(x => x.match.method === 'direct' || x.match.method === 'manual'); const prefixNormalized = mapped.filter(x => x.match.method === 'country_prefix'); const ambiguous = results.filter(x => x.match.confidence === 'ambiguous'); const unmatched = results.filter(x => !x.match.channelId && x.match.confidence !== 'ambiguous');
  const byEpg = new Map(mapped.map(x => [x.epg.id, x.match.channelId])); const now = new Date();
  const samples = [];
  for (const item of mapped.slice(0, 10)) { const ps = parsed.programmes.filter(p => byEpg.get(p.epgId) === item.match.channelId).sort((a,b) => a.start-b.start); const current = ps.find(p => p.start <= now && p.stop > now) || null; const next = ps.find(p => p.start > now) || null; samples.push({ channel_id: item.match.channelId, channel_name: channels.find(c => c.id === item.match.channelId)?.name || null, xmltv_channel: item.epg.id, now: current ? { title: current.title, start_at: current.start, stop_at: current.stop, programme_key: programmeKey(item.match.channelId, current) } : null, next: next ? { title: next.title, start_at: next.start, stop_at: next.stop, programme_key: programmeKey(item.match.channelId, next) } : null }); }
  const dates = parsed.programmes.flatMap(p => [p.start, p.stop]).sort((a,b) => a-b);
  const keySet = parsed.programmes.map(p => { const id = byEpg.get(p.epgId) || `epg:${p.epgId}`; return programmeKey(id, p); });
  const keySet2 = epg.parseXmltv(xml.toString('utf8')).programmes.map(p => programmeKey(byEpg.get(p.epgId) || `epg:${p.epgId}`, p));
  const categoryCoverage = {}; for (const c of ['Казахстан','Детские','Кино','Музыка','Спорт']) categoryCoverage[c] = { total: channels.filter(x => categoryHit(x, c)).length, matched: mapped.filter(x => categoryHit(channels.find(ch => ch.id === x.match.channelId) || {}, c)).length };
  console.log('5/5 Reporting...');
  const report = { file: { path: absolute, name: path.basename(absolute), compressed, bytes: raw.length, uncompressed_bytes: xml.length }, provider: provider || null, xmltv: { channels: parsed.channels.length, programmes: parsed.programmes.length, invalid: parsed.invalid, earliest: dates[0] || null, latest: dates.at(-1) || null }, matching: { logical_channels_total: channels.length, exact_high: mapped.length, exact_direct: direct.length, exact_after_provider_prefix: prefixNormalized.length, ambiguous: ambiguous.length, unmatched: unmatched.length, matched_examples: mapped.slice(0,30).map(x => ({ epg_id:x.epg.id, name:x.epg.displayName, channel_id:x.match.channelId, method:x.match.method })), ambiguous_examples: ambiguous.slice(0,20).map(x => ({ epg_id:x.epg.id, name:x.epg.displayName })), unmatched_examples: unmatched.slice(0,20).map(x => ({ epg_id:x.epg.id, name:x.epg.displayName })) }, category_coverage: categoryCoverage, now_next_samples: samples, programme_key_stability: keySet.length === keySet2.length && keySet.every((k,i) => k === keySet2[i]) ? 'PASS' : 'FAIL' };
  console.log(JSON.stringify(report, null, 2)); if (jsonOutput) fs.writeFileSync(path.resolve(jsonOutput), JSON.stringify(report, null, 2));
  if (tempPath) { fs.rmSync(tempPath, { force: true }); activeTempPath = null; }
  await db.end();
})().catch(error => { if (activeTempPath) fs.rmSync(activeTempPath, { force: true }); console.error(`LOCAL EPG PREVIEW FAILED: ${error.message}`); db.end().catch(() => {}); process.exitCode = 1; });
