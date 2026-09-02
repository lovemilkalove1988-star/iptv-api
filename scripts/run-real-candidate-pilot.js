const fs = require('fs');
const db = require('../database');
const { stageProvider, healthCheckBatch } = require('../services/milktv-m3u-pilot');
const { classifyCandidateForIngestion } = require('../services/milktv-source-ingestion');

const TARGET_URLS = [
  'https://iptv-org.github.io/iptv/countries/kz.m3u',
  'https://iptv-org.github.io/iptv/countries/ru.m3u'
];

async function count(table) { return (await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count; }

(async () => {
  const report = { started_at: new Date().toISOString(), providers: [], ingestion: { auto_eligible: 0, review_required: 0, rejected: 0, reasons: {} }, category_coverage: {} };
  const checkedIds = [];
  try {
    report.before = { channels: await count('channels'), sources: await count('milktv_channel_sources'), candidates: await count('milktv_m3u_candidates'), provenance: await count('milktv_m3u_candidate_providers'), audit: await count('milktv_source_ingestion_audit') };
    const providers = (await db.query('SELECT id,name,url,enabled FROM milktv_m3u_providers WHERE url = ANY($1::text[]) ORDER BY id', [TARGET_URLS])).rows;
    for (const provider of providers) {
      const item = { provider_id: provider.id, provider: provider.name, url: provider.url, enabled: provider.enabled };
      if (!provider.enabled) { item.status = 'SKIPPED_DISABLED'; report.providers.push(item); continue; }
      try {
        Object.assign(item, await stageProvider(db, provider));
        const limit = provider.url.endsWith('/kz.m3u') ? 37 : 100;
        const candidates = (await db.query(`SELECT c.* FROM milktv_m3u_candidates c JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id WHERE cp.provider_id=$1 AND cp.active=TRUE ORDER BY c.id LIMIT $2`, [provider.id, limit])).rows;
        const health = await healthCheckBatch(db, candidates, { concurrency: 4, timeoutMs: 8000 });
        checkedIds.push(...health.map(x => Number(x.candidate_id)));
        item.health = { checked: health.length, online: health.filter(x => x.online).length, offline: health.filter(x => !x.online).length, with_error: health.filter(x => Boolean(x.error)).length };
      } catch (error) { item.status = 'ERROR'; item.error = String(error.message).slice(0, 300); }
      report.providers.push(item);
    }
    const candidates = checkedIds.length ? (await db.query(`SELECT c.*, EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id) AS has_provenance,
      NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp2 WHERE cp2.candidate_id=c.id AND cp2.active=TRUE) AS is_stale
      FROM milktv_m3u_candidates c WHERE c.id = ANY($1::int[]) ORDER BY c.id`, [checkedIds])).rows : [];
    const providerNames = new Map((await db.query('SELECT id,name FROM milktv_m3u_providers')).rows.map(p => [Number(p.id), p.name]));
    const candidateProviders = new Map();
    if (checkedIds.length) { const links = (await db.query('SELECT candidate_id,provider_id FROM milktv_m3u_candidate_providers WHERE candidate_id = ANY($1::int[])', [checkedIds])).rows; for (const link of links) { const key = Number(link.candidate_id); if (!candidateProviders.has(key)) candidateProviders.set(key, []); candidateProviders.get(key).push(providerNames.get(Number(link.provider_id)) || `provider-${link.provider_id}`); } }
    const categoryRows = (await db.query(`SELECT channel_id,category FROM milktv_channel_categories`)).rows;
    const categoryByChannel = new Map(categoryRows.map(x => [Number(x.channel_id), x.category]));
    for (const bucket of ['Казахстан','Детские','Кино','Музыка','Спорт','Без категории']) report.category_coverage[bucket] = { matched: 0, auto_eligible: 0 };
    for (const candidate of candidates) {
      const decision = await classifyCandidateForIngestion(db, candidate);
      const key = decision.reason || 'unknown'; report.ingestion[decision.outcome === 'AUTO_ELIGIBLE' ? 'auto_eligible' : decision.outcome === 'REVIEW_REQUIRED' ? 'review_required' : 'rejected']++;
      report.ingestion.reasons[key] = (report.ingestion.reasons[key] || 0) + 1;
      if (decision.channel_id) { const category = categoryByChannel.get(Number(decision.channel_id)) || 'Без категории'; const bucket = report.category_coverage[category] || (report.category_coverage['Без категории']); bucket.matched++; if (decision.outcome === 'AUTO_ELIGIBLE') bucket.auto_eligible++; }
    }
    report.ingestion_by_provider = {};
    for (const candidate of candidates) for (const provider of (candidateProviders.get(Number(candidate.id)) || ['unknown'])) {
      const decision = await classifyCandidateForIngestion(db, candidate); const bucket = report.ingestion_by_provider[provider] || (report.ingestion_by_provider[provider] = { auto_eligible: 0, review_required: 0, rejected: 0, reasons: {} });
      const field = decision.outcome === 'AUTO_ELIGIBLE' ? 'auto_eligible' : decision.outcome === 'REVIEW_REQUIRED' ? 'review_required' : 'rejected'; bucket[field]++; bucket.reasons[decision.reason] = (bucket.reasons[decision.reason] || 0) + 1;
    }
    report.health_scope = { checked_candidate_ids: checkedIds, count: checkedIds.length, classification_scope: 'fresh DB rows for checked IDs only' };
    report.after = { channels: await count('channels'), sources: await count('milktv_channel_sources'), candidates: await count('milktv_m3u_candidates'), provenance: await count('milktv_m3u_candidate_providers'), audit: await count('milktv_source_ingestion_audit') };
    report.source_ingestion_executed = false;
    fs.writeFileSync('real-candidate-pilot-20260831.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`PILOT_FAILED: ${error.message}`); process.exitCode = 1; }
  finally { await db.end(); }
})();
