function isPublicCandidateUrl(raw) {
  try {
    const u = new URL(String(raw || '')), host = u.hostname.toLowerCase();
    return ['http:', 'https:'].includes(u.protocol) && !/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) && host !== 'localhost' && !host.endsWith('.localhost') && !/(test|example|dummy|placeholder|backup-test|test-backup)/i.test(`${host} ${raw}`);
  } catch (_) { return false; }
}
function classifyCandidate(candidate, context = {}) {
  if (!candidate) return { outcome: 'REJECTED', reason: 'reject_candidate_missing' };
  if (candidate.state === 'rejected') return { outcome: 'REJECTED', reason: 'reject_candidate_rejected' };
  if (candidate.state === 'accepted') return { outcome: 'REJECTED', reason: 'reject_already_ingested' };
  if (candidate.is_stale) return { outcome: 'REJECTED', reason: 'reject_stale_candidate' };
  if (!candidate.stream_url || !/^https?:\/\//i.test(candidate.stream_url)) return { outcome: 'REJECTED', reason: 'reject_invalid_url' };
  if (!isPublicCandidateUrl(candidate.stream_url)) return { outcome: 'REJECTED', reason: 'reject_unsafe_url' };
  if (candidate.health_status !== 'online') return candidate.health_status === 'offline'
    ? { outcome: 'REJECTED', reason: 'reject_offline' }
    : { outcome: 'REVIEW_REQUIRED', reason: 'review_health_unknown' };
  if (!candidate.suggested_channel_id) return { outcome: 'REVIEW_REQUIRED', reason: 'review_possible_match' };
  if (candidate.match_confidence === 'possible') return { outcome: 'REVIEW_REQUIRED', reason: 'review_possible_match' };
  if (candidate.match_confidence !== 'high') return { outcome: 'REVIEW_REQUIRED', reason: 'review_ambiguous' };
  if (!candidate.has_provenance) return { outcome: 'REJECTED', reason: 'reject_missing_provenance' };
  if (context.duplicate === 'same_channel') return { outcome: 'REJECTED', reason: 'reject_duplicate_source' };
  if (context.duplicate === 'other_channel') return { outcome: 'REJECTED', reason: 'reject_conflicting_channel' };
  return { outcome: 'AUTO_ELIGIBLE', reason: 'auto_eligible_exact_match', channel_id: Number(candidate.suggested_channel_id) };
}

async function getCandidateSourceDuplicate(db, candidate) {
  const url = String(candidate?.stream_url || '').trim();
  const channelId = Number(candidate?.suggested_channel_id || 0);
  if (!url || !channelId) return null;
  const result = await db.query('SELECT id,channel_id FROM milktv_channel_sources WHERE url=$1 FOR SHARE', [url]);
  if (!result.rows.length) return null;
  return result.rows.some(row => Number(row.channel_id) === channelId) ? { type: 'same_channel', source_id: result.rows.find(row => Number(row.channel_id) === channelId).id } : { type: 'other_channel', source_id: result.rows[0].id };
}

async function classifyCandidateForIngestion(db, candidate) {
  const duplicate = await getCandidateSourceDuplicate(db, candidate);
  return { ...classifyCandidate(candidate, { duplicate: duplicate?.type }), duplicate };
}

async function ingestCandidate(db, candidateId, options = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT * FROM milktv_m3u_candidates WHERE id=$1 FOR UPDATE', [candidateId]);
    if (!c.rows.length) throw new Error('Candidate not found');
    const candidate = c.rows[0];
    const prov = await client.query("SELECT cp.provider_id,p.name FROM milktv_m3u_candidate_providers cp LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id WHERE cp.candidate_id=$1", [candidateId]);
    const hydrated = { ...candidate, has_provenance: prov.rows.length > 0 };
    const duplicate = await getCandidateSourceDuplicate(client, hydrated);
    const decision = classifyCandidate(hydrated, { duplicate: duplicate?.type });
    if (decision.outcome !== 'AUTO_ELIGIBLE') { await client.query('ROLLBACK'); return decision; }
    const channel = await client.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [decision.channel_id]);
    if (!channel.rows.length) throw new Error('Target channel not found');
    const existing = await client.query('SELECT id,channel_id FROM milktv_channel_sources WHERE url=$1 FOR UPDATE', [candidate.stream_url]);
    if (existing.rows.some(x => Number(x.channel_id) !== decision.channel_id)) throw new Error('reject_conflicting_channel');
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return { outcome: 'REJECTED', reason: existing.rows.some(x => Number(x.channel_id) !== decision.channel_id) ? 'reject_conflicting_channel' : 'reject_duplicate_source', source_id: existing.rows[0].id };
    }
    let sourceId;
    if (!sourceId) { const priority = Number(options.reservePriority || 100); const inserted = await client.query('INSERT INTO milktv_channel_sources(channel_id,url,enabled,priority) VALUES($1,$2,TRUE,$3) RETURNING id', [decision.channel_id, candidate.stream_url, priority]); sourceId = inserted.rows[0].id; }
    for (const p of prov.rows) await client.query("INSERT INTO milktv_channel_source_provenance(source_id,origin_type,m3u_provider_id,candidate_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [sourceId, String(p.name || '').startsWith('Manual URL:') ? 'manual' : String(p.name || '').startsWith('Official:') ? 'official' : 'm3u', p.provider_id, candidateId]);
    await client.query("UPDATE milktv_m3u_candidates SET state='accepted',accepted_channel_id=$1,updated_at=NOW() WHERE id=$2", [decision.channel_id, candidateId]);
    await client.query("INSERT INTO milktv_source_ingestion_audit(candidate_id,channel_id,source_id,action,reason) VALUES($1,$2,$3,'ingested',$4)",[candidateId,decision.channel_id,sourceId,decision.reason]);
    await client.query('COMMIT'); return { ...decision, source_id: sourceId };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// A deliberate administrator match uses the same candidate/source/provenance
// pipeline as automatic ingestion.  It never creates a logical channel and
// therefore cannot silently publish an imported stream to clients.
async function ingestCandidateToChannel(db, candidateId, channelId, options = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const candidateResult = await client.query('SELECT * FROM milktv_m3u_candidates WHERE id=$1 FOR UPDATE', [candidateId]);
    if (!candidateResult.rows.length) throw new Error('Candidate not found');
    const candidate = candidateResult.rows[0];
    const provenance = await client.query("SELECT cp.provider_id,p.name FROM milktv_m3u_candidate_providers cp LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id WHERE cp.candidate_id=$1 AND cp.active=TRUE", [candidateId]);
    const active = provenance.rows.length > 0;
    if (candidate.state === 'rejected' || candidate.state === 'accepted') throw new Error('Candidate is not available for ingestion');
    if (!active || !isPublicCandidateUrl(candidate.stream_url) || candidate.health_status !== 'online') throw new Error('Candidate is not safe to add as a source');
    const channel = await client.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
    if (!channel.rows.length) throw new Error('Target channel not found');
    const existing = await client.query('SELECT id,channel_id FROM milktv_channel_sources WHERE url=$1 FOR UPDATE', [candidate.stream_url]);
    if (existing.rows.some(row => Number(row.channel_id) !== Number(channelId))) throw new Error('reject_conflicting_channel');
    if (existing.rows.length) throw new Error('reject_duplicate_source');
    const priority = Number(options.reservePriority || 100);
    const inserted = await client.query('INSERT INTO milktv_channel_sources(channel_id,url,enabled,priority) VALUES($1,$2,TRUE,$3) RETURNING id', [channelId, candidate.stream_url, priority]);
    for (const provider of provenance.rows) {
      await client.query("INSERT INTO milktv_channel_source_provenance(source_id,origin_type,m3u_provider_id,candidate_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [inserted.rows[0].id, String(provider.name || '').startsWith('Manual URL:') ? 'manual' : String(provider.name || '').startsWith('Official:') ? 'official' : 'm3u', provider.provider_id, candidateId]);
    }
    await client.query("UPDATE milktv_m3u_candidates SET state='accepted',accepted_channel_id=$1,updated_at=NOW() WHERE id=$2", [channelId, candidateId]);
    await client.query("INSERT INTO milktv_source_ingestion_audit(candidate_id,channel_id,source_id,action,reason) VALUES($1,$2,$3,'ingested',$4)", [candidateId, channelId, inserted.rows[0].id, 'admin_confirmed_match']);
    await client.query('COMMIT');
    return { outcome: 'INGESTED', reason: 'admin_confirmed_match', channel_id: Number(channelId), source_id: inserted.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
module.exports = { isPublicCandidateUrl, classifyCandidate, classifyCandidateForIngestion, getCandidateSourceDuplicate, ingestCandidate, ingestCandidateToChannel };
