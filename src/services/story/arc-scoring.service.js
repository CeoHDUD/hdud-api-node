function clamp(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0; }

export function scoreNarrativeArc({ arc = {}, validation = {}, completion = {}, candidate = {} } = {}) {
  const progression = Array.isArray(arc.progression) ? arc.progression : [];
  const classified = progression.filter((item) => item.source === 'AUTHOR_NTG_CLASSIFICATION').length;
  const classificationCoverage = progression.length ? (classified / progression.length) * 100 : 0;
  const graphScore = clamp(candidate.graph_narrative_score ?? candidate.narrative_path_validation?.average_graph_score ?? 0);
  const truthScore = clamp(candidate.truth_score ?? candidate.confidence ?? 0);
  const violationPenalty = (validation.violations || []).length * 6;
  const consistency = clamp((graphScore * 0.45) + (truthScore * 0.25) + (classificationCoverage * 0.2) + (validation.coherent ? 10 : 0) - violationPenalty);
  const overall = clamp((consistency * 0.58) + (Number(completion.completion_score || 0) * 0.42));

  return {
    consistency_score: consistency,
    completion_score: clamp(completion.completion_score),
    overall_arc_score: overall,
    classification_coverage: clamp(classificationCoverage),
    graph_score: graphScore,
    truth_score: truthScore,
    quality: overall >= 85 ? 'HIGH' : overall >= 65 ? 'MEDIUM' : overall >= 45 ? 'EMERGING' : 'WEAK',
  };
}
