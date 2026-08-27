// C:\HDUD_DATA\hdud-api-node\src\services\stories\story-truth-health.service.js

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeRisk(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'low' || s === 'baixo') return 12;
  if (s === 'medium' || s === 'médio' || s === 'medio') return 45;
  if (s === 'high' || s === 'alto') return 78;
  const n = Number(value);
  if (Number.isFinite(n)) return n <= 1 ? n * 100 : n;
  return 50;
}

function classifyReadiness({ truthHealthScore, evidenceCoverage, timelineCoverage, hallucinationRisk }) {
  if (truthHealthScore >= 90 && evidenceCoverage >= 95 && timelineCoverage >= 85 && hallucinationRisk <= 20) {
    return 'READY_FOR_EDITORIAL_REVIEW';
  }

  if (truthHealthScore >= 75 && evidenceCoverage >= 80 && timelineCoverage >= 65 && hallucinationRisk <= 40) {
    return 'REVIEW_RECOMMENDED';
  }

  if (truthHealthScore >= 60 && evidenceCoverage >= 65 && hallucinationRisk <= 55) {
    return 'NEEDS_ATTENTION';
  }

  return 'BLOCKED_BY_TRUTH_GAPS';
}

export function buildStoryTruthHealth({ evidenceMap, paragraphScores, storyTimeline }) {
  const evidence = safeArray(evidenceMap?.paragraphs || evidenceMap);
  const scores = safeArray(paragraphScores?.paragraphs || paragraphScores);
  const timeline = safeObject(storyTimeline);
  const events = safeArray(timeline.events || timeline.ordered_events);
  const gaps = safeArray(timeline.gaps || timeline.narrative_gaps);

  const paragraphCount = Math.max(evidence.length, scores.length, 0);
  const evidencedParagraphs = evidence.filter((p) => safeArray(p?.source_memories).length > 0).length;
  const missingEvidenceCount = Math.max(paragraphCount - evidencedParagraphs, 0);
  const evidenceCoverage = paragraphCount > 0 ? (evidencedParagraphs / paragraphCount) * 100 : 0;

  const scoredTruth = scores
    .map((p) => Number(p?.truth_score ?? p?.score))
    .filter((n) => Number.isFinite(n));

  const avgTruthScore = scoredTruth.length
    ? scoredTruth.reduce((a, b) => a + b, 0) / scoredTruth.length
    : evidenceCoverage;

  const riskValues = evidence
    .map((p) => normalizeRisk(p?.hallucination_risk))
    .filter((n) => Number.isFinite(n));

  const hallucinationRisk = riskValues.length
    ? riskValues.reduce((a, b) => a + b, 0) / riskValues.length
    : Math.max(0, 100 - evidenceCoverage);

  const timelineCoverage = paragraphCount > 0
    ? Math.min(100, (events.length / paragraphCount) * 100)
    : clampScore(Number(timeline.temporal_confidence || 0) * 100, 0);

  const chronologyScore = clampScore(timeline.chronology_score ?? timeline.chronologyScore ?? timelineCoverage, timelineCoverage);
  const temporalConfidence = Number(timeline.temporal_confidence ?? timeline.temporalConfidence);
  const temporalConfidenceScore = Number.isFinite(temporalConfidence)
    ? clampScore(temporalConfidence <= 1 ? temporalConfidence * 100 : temporalConfidence, timelineCoverage)
    : timelineCoverage;

  const auditabilityScore = clampScore(
    evidenceCoverage * 0.45 + timelineCoverage * 0.25 + chronologyScore * 0.2 + temporalConfidenceScore * 0.1,
    0
  );

  const truthHealthScore = clampScore(
    avgTruthScore * 0.45 + auditabilityScore * 0.35 + (100 - hallucinationRisk) * 0.2,
    0
  );

  const readinessStatus = classifyReadiness({
    truthHealthScore,
    evidenceCoverage,
    timelineCoverage,
    hallucinationRisk,
  });

  return {
    truth_health_score: truthHealthScore,
    auditability_score: auditabilityScore,
    evidence_coverage: clampScore(evidenceCoverage),
    timeline_coverage: clampScore(timelineCoverage),
    hallucination_risk: clampScore(hallucinationRisk),
    chronology_score: chronologyScore,
    temporal_confidence: clampScore(temporalConfidenceScore),
    readiness_status: readinessStatus,
    missing_evidence_count: missingEvidenceCount,
    temporal_gap_count: gaps.length,
    paragraph_count: paragraphCount,
    evidenced_paragraph_count: evidencedParagraphs,
  };
}
