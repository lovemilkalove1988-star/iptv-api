// Pluggable, admin-only discovery provider.  A deployment can point this at a
// compliant search API without coupling catalog/search UI to a vendor.
function configured() {
  return Boolean(String(process.env.MILKTV_WEB_SEARCH_PROVIDER_URL || "").trim());
}

async function search(query) {
  const endpoint = String(process.env.MILKTV_WEB_SEARCH_PROVIDER_URL || "").trim();
  if (!endpoint) return { configured: false, provider: null, results: [] };
  const url = new URL(endpoint);
  url.searchParams.set("q", String(query || "").trim());
  const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error(`Web search provider HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body?.results) ? body.results : [];
  // URLs are not trusted here; ingestion/discovery must validate them before use.
  return { configured: true, provider: url.hostname, results: rows.slice(0, 25) };
}

module.exports = { configured, search };
