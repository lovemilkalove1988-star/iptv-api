const fs = require('fs');
const crypto = require('crypto');

function decode(v) { return String(v || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))); }
function attrs(s) { const out = {}; for (const m of String(s).matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)) out[m[1]] = decode(m[2]); return out; }
function xmlDate(v) { const m = String(v || '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/); if (!m) return new Date(v); return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? m[7].slice(0,3)+':'+m[7].slice(3) : 'Z'}`); }
function key(channelId, p) { return crypto.createHash('sha1').update(`${channelId}|${p.start.toISOString()}|${p.title}`).digest('hex'); }

async function previewXmltvStream(filePath, logicalChannels, matchChannel, options = {}) {
  const channelMap = new Map(); const matched = []; const channelResults = []; const programmesByEpg = new Map(); let buffer = ''; let channels = 0; let programmes = 0; let invalid = 0; let earliest = null; let latest = null;
  const processTag = (tag) => {
    if (/^<channel\b/i.test(tag)) { const a = attrs(tag.slice(8, -1)); channelMap.set(a.id, { id: a.id, displayName: '' }); channels++; return; }
    if (/^<programme\b/i.test(tag)) { return; }
  };
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  for await (const chunk of stream) {
    buffer += chunk;
    let end;
    while (buffer.indexOf('<') >= 0 && (end = buffer.indexOf('>')) >= 0) {
      const lt = buffer.indexOf('<'); if (lt > 0) { buffer = buffer.slice(lt); end = buffer.indexOf('>'); }
      const token = buffer.slice(0, end + 1); buffer = buffer.slice(end + 1);
      if (/^<channel\b/i.test(token) && !/\/>$/.test(token)) { const a = attrs(token.slice(8, -1)); const close = buffer.indexOf('</channel>'); if (close < 0) { buffer = token + buffer; break; } const body = buffer.slice(0, close); buffer = buffer.slice(close + 10); const d = body.match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/i); const item = { id: a.id, displayName: decode(d ? d[1].replace(/<[^>]+>/g, '') : '') }; channelMap.set(a.id, item); channels++; const m = matchChannel(item, logicalChannels); channelResults.push({ epg: item, match: m }); if (m.channelId) matched.push({ epg: item, match: m }); continue; }
      if (/^<programme\b/i.test(token)) { const close = buffer.indexOf('</programme>'); if (close < 0) { buffer = token + buffer; break; } const body = buffer.slice(0, close); buffer = buffer.slice(close + 12); const a = attrs(token.slice(10, -1)); const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i); const start = xmlDate(a.start), stop = xmlDate(a.stop), title = decode(titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : ''); programmes++; if (!a.channel || isNaN(start) || isNaN(stop) || stop <= start || !title) { invalid++; continue; } if (!earliest || start < earliest) earliest = start; if (!latest || stop > latest) latest = stop; const found = matched.find(x => x.epg.id === a.channel); if (found) { if (!programmesByEpg.has(a.channel)) programmesByEpg.set(a.channel, []); const list = programmesByEpg.get(a.channel); if (options.collectAllMatched || list.length < (options.samplePerChannel || 20)) list.push({ epgId: a.channel, start, stop, title, programme_key: key(found.match.channelId, { start, title }) }); } }
    }
  }
  return { channels, programmes, invalid, earliest, latest, matched, channelResults, programmesByEpg };
}
module.exports = { previewXmltvStream };
