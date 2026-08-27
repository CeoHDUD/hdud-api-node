// C:\HDUD_DATA\hdud-api-node\src\services\story\story-confidence.service.js
//
// GO LIVE 002.8 — Story Confidence Service
// Responsabilidade: converter sinais narrativos em maturidade editorial da candidata.

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function classifyStoryConfidence(score) {
  const value = clamp(score, 0, 100);
  if (value >= 95) return { code: "MATURE", label: "História Madura", description: "pronta para virar uma História Viva" };
  if (value >= 80) return { code: "VERY_STRONG", label: "Muito Forte", description: "continuidade narrativa muito clara" };
  if (value >= 65) return { code: "CONSISTENT", label: "Consistente", description: "há sinais suficientes para explorar" };
  if (value >= 45) return { code: "EMERGING", label: "Emergente", description: "ainda está amadurecendo" };
  return { code: "INSUFFICIENT", label: "Insuficiente", description: "ainda não há história suficiente" };
}

export function calculateStoryConfidence({ memoryCount = 0, continuity = {}, hasTimeSpan = false } = {}) {
  const dimensions = continuity?.dimensions || {};
  const countScore = Math.min(22, Math.max(0, Number(memoryCount) - 1) * 5.5);
  const continuityScore = Number(continuity?.score || 0) * 48;
  const densityScore = (
    Number(dimensions.characters || 0) * 9 +
    Number(dimensions.context || 0) * 7 +
    Number(dimensions.emotional || 0) * 5 +
    Number(dimensions.transformation || 0) * 5 +
    Number(dimensions.consequence || 0) * 4
  );
  const spanScore = hasTimeSpan ? 6 : 2;

  const raw = countScore + continuityScore + densityScore + spanScore;
  const confidence = Math.round(clamp(raw, 0, 100));
  const maturity = classifyStoryConfidence(confidence);

  return {
    confidence,
    maturity_code: maturity.code,
    maturity_label: maturity.label,
    maturity_description: maturity.description,
  };
}

export function isDisplayCandidate(candidate) {
  return Number(candidate?.confidence || 0) >= 65 && safeArray(candidate?.related_memories).length >= 2;
}

export const StoryConfidenceService = {
  calculateStoryConfidence,
  classifyStoryConfidence,
  isDisplayCandidate,
};
