function calculateProviderReputation(e = {}) {
  const candidateCount = Math.max(0, Number(e.candidate_count || 0));
  const candidateOnline = Math.max(0, Number(e.online_count || 0));
  const candidateAccepted = Math.max(0, Number(e.accepted_count || 0));
  const realSources = Math.max(0, Number(e.real_source_count || 0));
  const trusted = Math.max(0, Number(e.trusted_count || 0));
  const unstable = Math.max(0, Number(e.unstable_count || 0));
  const evidence = candidateCount + realSources;
  if (!evidence) return { score: 0, level: "unknown", reasons: { candidateCount, candidateOnline, candidateAccepted, realSources, trusted, unstable } };
  const score = Math.max(0, Math.min(100, Math.round(
    Math.min(45, trusted * 15) + Math.min(25, realSources * 3) +
    Math.min(15, candidateOnline * 5) + Math.min(10, candidateAccepted * 2) - Math.min(40, unstable * 10) - Math.min(20, Math.max(0, candidateCount - candidateOnline) * 2)
  )));
  const level = trusted >= 3 && score >= 65 ? "reliable" : score < 30 ? "poor" : (trusted || candidateAccepted || candidateOnline) ? "mixed" : "unproven";
  return { score, level, reasons: { candidateCount, candidateOnline, candidateAccepted, realSources, trusted, unstable } };
}
module.exports = { calculateProviderReputation };
