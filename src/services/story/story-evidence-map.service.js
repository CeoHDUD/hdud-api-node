// C:\HDUD_DATA\hdud-api-node\src\services\story\story-evidence-map.service.js

import { buildParagraphEvidenceMap, assertEveryParagraphHasEvidence } from './paragraph-evidence-builder.service.js';

function average(values = []) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(4));
}

function qualityDistribution(evidenceMap = []) {
  return evidenceMap.reduce((acc, item) => {
    const key = item.evidence_quality || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function riskDistribution(evidenceMap = []) {
  return evidenceMap.reduce((acc, item) => {
    const key = item.hallucination_risk || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function computeGlobalQuality(evidenceMap = []) {
  const avgTruth = average(evidenceMap.map((item) => item.truth_score));
  const unsupported = evidenceMap.filter((item) => item.evidence_quality === 'unsupported').length;
  const criticalRisk = evidenceMap.filter((item) => item.hallucination_risk === 'critical').length;

  if (!evidenceMap.length) return 'empty';
  if (unsupported || criticalRisk) return 'blocked';
  if (avgTruth >= 0.78) return 'strong';
  if (avgTruth >= 0.62) return 'good';
  if (avgTruth >= 0.46) return 'moderate';
  return 'weak';
}

export function buildStoryEvidenceMap({ storyId = null, manuscript = '', memories = [], generationContext = {} } = {}) {
  const evidenceMap = buildParagraphEvidenceMap({
    manuscript,
    memories,
    generationContext: {
      ...generationContext,
      story_id: storyId ?? generationContext.story_id ?? null,
    },
  });

  const validation = assertEveryParagraphHasEvidence(evidenceMap);
  const paragraphScores = evidenceMap.map((item) => ({
    paragraph_id: item.paragraph_id,
    paragraph_order: item.paragraph_order,
    truth_score: item.truth_score,
    evidence_quality: item.evidence_quality,
    hallucination_risk: item.hallucination_risk,
  }));

  const summary = {
    story_id: storyId,
    paragraph_count: evidenceMap.length,
    evidence_quality: computeGlobalQuality(evidenceMap),
    truth_score: average(evidenceMap.map((item) => item.truth_score)),
    hallucination_risk: evidenceMap.some((item) => item.hallucination_risk === 'critical')
      ? 'critical'
      : evidenceMap.some((item) => item.hallucination_risk === 'high')
        ? 'high'
        : evidenceMap.some((item) => item.hallucination_risk === 'medium')
          ? 'medium'
          : 'low',
    quality_distribution: qualityDistribution(evidenceMap),
    risk_distribution: riskDistribution(evidenceMap),
    validation,
  };

  return {
    ok: validation.ok,
    story_id: storyId,
    evidence_map: evidenceMap,
    evidence_quality: summary.evidence_quality,
    lineage: {
      lineage_type: 'story_evidence_map',
      story_id: storyId,
      source_memory_ids: [...new Set(evidenceMap.flatMap((item) => item.source_memories.map((memory) => memory.memory_id)))],
      paragraph_count: evidenceMap.length,
      generated_at: new Date().toISOString(),
      generation_context: generationContext,
    },
    paragraph_scores: paragraphScores,
    summary,
  };
}

export default {
  buildStoryEvidenceMap,
};
