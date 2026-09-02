const crypto = require('crypto');
function parseXmltvDate(value){const raw=String(value||'').trim();const m=raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);if(m){const iso=`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]?m[7].slice(0,3)+':'+m[7].slice(3):'Z'}`;return new Date(iso)}return new Date(raw)}
function parseXmltv(xml){const text=String(xml||'');const channels=[...text.matchAll(/<channel\s+[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi)].map(m=>({id:m[1],displayName:(m[2].match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/i)||[])[1]||'',icon:(m[2].match(/<icon[^>]*src="([^"]+)"/i)||[])[1]||null}));const programmes=[];let invalid=0;for(const m of text.matchAll(/<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi)){const a={};for(const x of m[1].matchAll(/(\w+)="([^"]*)"/g))a[x[1]]=x[2];const start=parseXmltvDate(a.start),stop=parseXmltvDate(a.stop),title=(m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1];if(!a.channel||isNaN(start)||isNaN(stop)||stop<=start||!title){invalid++;continue}programmes.push({epgId:a.channel,start,stop,title,subTitle:(m[2].match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/i)||[])[1]||null})}return {channels,programmes,invalid}}

/** Shared, transaction-safe EPG import used by manual and scheduled runs. */
async function importMilktvEpgSource(db, source, options = {}) {
  const fetchXml = options.fetchXml;
  const matcher = options.matcher;
  if (typeof fetchXml !== 'function' || typeof matcher !== 'function') throw new Error('EPG import dependencies unavailable');
  const lockKey = 960000 + Number(source.id);
  const lockClient = await db.connect();
  let locked = false;
  try {
    locked = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey])).rows[0].locked;
    if (!locked) return { skipped: true, reason: 'lock_busy', source_id: source.id };
    const xml = await fetchXml(source.url);
    const parsed = parseXmltv(xml);
    if (!parsed.channels.length) throw Object.assign(new Error('EPG validation failed: zero channels'), { code: 'EMPTY_EPG' });
    if (!parsed.programmes.length) throw Object.assign(new Error('EPG validation failed: zero programmes'), { code: 'EMPTY_EPG' });
    const logicalChannels = (await lockClient.query('SELECT id,name FROM channels')).rows;
    const mappings = parsed.channels.map(epg => ({ epg, match: matcher(epg, logicalChannels) })).filter(x => x.match && x.match.channelId);
    const now = new Date();
    const from = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const client = lockClient;
    await client.query('BEGIN');
    try {
      for (const { epg, match } of mappings) {
        await client.query("INSERT INTO milktv_epg_channels(channel_id,epg_id,display_name,match_status,match_confidence,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(channel_id) DO UPDATE SET epg_id=CASE WHEN milktv_epg_channels.match_status='manual' THEN milktv_epg_channels.epg_id ELSE EXCLUDED.epg_id END,display_name=EXCLUDED.display_name,match_status=CASE WHEN milktv_epg_channels.match_status='manual' THEN milktv_epg_channels.match_status ELSE EXCLUDED.match_status END,match_confidence=CASE WHEN milktv_epg_channels.match_status='manual' THEN milktv_epg_channels.match_confidence ELSE EXCLUDED.match_confidence END,updated_at=NOW()", [match.channelId, epg.id, epg.displayName, match.status, match.confidence]);
      }
      const byEpg = new Map(mappings.map(x => [x.epg.id, x.match.channelId]));
      let imported = 0;
      for (const programme of parsed.programmes) {
        const channelId = byEpg.get(programme.epgId);
        if (!channelId || programme.start < from || programme.start > to) continue;
        const key = crypto.createHash('sha1').update(`${channelId}|${programme.start.toISOString()}|${programme.title}`).digest('hex');
        await client.query("INSERT INTO milktv_epg_programmes(channel_id,start_at,stop_at,title,sub_title,programme_key,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(channel_id,programme_key) DO UPDATE SET stop_at=EXCLUDED.stop_at,title=EXCLUDED.title,sub_title=EXCLUDED.sub_title,updated_at=NOW()", [channelId, programme.start, programme.stop, programme.title, programme.subTitle, key]);
        imported++;
      }
      if (mappings.length) {
        const ids = mappings.map(x => x.match.channelId);
        await client.query("DELETE FROM milktv_epg_programmes WHERE channel_id = ANY($1::int[]) AND (start_at < $2 OR start_at > $3)", [ids, from, to]);
      }
      await client.query("UPDATE milktv_epg_sources SET last_import_attempt_at=NOW(),last_successful_import_at=NOW(),last_import_status='ok',import_status='ok',last_import_error=NULL,import_error=NULL,updated_at=NOW() WHERE id=$1", [source.id]);
      await client.query('COMMIT');
      return { skipped: false, source_id: source.id, channels: parsed.channels.length, programmes: imported, mapped: mappings.length, invalid: parsed.invalid, earliest: parsed.programmes.reduce((v, p) => !v || p.start < v ? p.start : v, null), latest: parsed.programmes.reduce((v, p) => !v || p.stop > v ? p.stop : v, null) };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } catch (error) {
    await lockClient.query("UPDATE milktv_epg_sources SET last_import_attempt_at=NOW(),last_import_status='error',import_status='error',last_import_error=$2,import_error=$2,updated_at=NOW() WHERE id=$1", [source.id, String(error.message).slice(0, 1000)]).catch(() => {});
    throw error;
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
    lockClient.release();
  }
}
async function getNowNext(db,channelId){const r=await db.query("SELECT programme_key,title,sub_title,start_at,stop_at FROM milktv_epg_programmes WHERE channel_id=$1 AND stop_at>NOW() ORDER BY start_at LIMIT 2",[channelId]);const history=await db.query("SELECT 1 FROM milktv_epg_programmes WHERE channel_id=$1 LIMIT 1",[channelId]);const nowAt=new Date();const now=r.rows.find(p=>new Date(p.start_at)<=nowAt&&new Date(p.stop_at)>nowAt)||null;const next=r.rows.find(p=>new Date(p.start_at)>nowAt)||null;const status=now?'live':history.rows.length?'stale':'missing';let progress_percent=0;if(now){progress_percent=Math.max(0,Math.min(100,Math.round((Date.now()-new Date(now.start_at))/(new Date(now.stop_at)-new Date(now.start_at))*100)))}return {channel_id:channelId,epg_status:status,now:now?{...now,progress_percent}:null,next}}
async function getSchedule(db,channelId,from,to){const r=await db.query("SELECT * FROM milktv_epg_programmes WHERE channel_id=$1 AND start_at<$3 AND stop_at>$2 ORDER BY start_at",[channelId,from||new Date(),to||new Date(Date.now()+7*86400000)]);return r.rows}
module.exports={parseXmltv,getNowNext,getSchedule,importMilktvEpgSource};
