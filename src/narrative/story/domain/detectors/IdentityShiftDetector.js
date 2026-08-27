const { StorySignalType } = require('../value-objects/StorySignal');
const { normalizeText, includesAny } = require('./lexical-story-detectors');
const { getMemoryId, buildMemoryText } = require('../services/StorySignalExtractor');

const BEFORE_MARKERS = Object.freeze([
  'antes',
  'eu era',
  'eu costumava',
  'naquela epoca',
  'quando eu era',
  'no inicio',
  'antigamente',
]);

const AFTER_MARKERS = Object.freeze([
  'hoje',
  'agora',
  'me tornei',
  'passei a ser',
  'aprendi a ser',
  'sou hoje',
  'desde entao',
]);

const TRANSFORMATION_MARKERS = Object.freeze([
  'mudei',
  'mudou',
  'transformei',
  'transformou',
  'virei',
  'deixei de ser',
  'passei a',
  'aprendi',
  'amadureci',
  'cresci',
  'recomecei',
]);

const IDENTITY_QUALITY_MARKERS = Object.freeze([
  'coragem',
  'confiante',
  'autonomia',
  'independente',
  'lideranca',
  'lider',
  'pai',
  'mae',
  'profissional',
  'adulto',
  'responsavel',
  'forte',
  'livre',
]);

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function countSignalTypes(signals = [], types = []) {
  return signals.filter((signal) => types.includes(signal.type)).length;
}

function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function extractMatchedTerms(text, terms) {
  const normalized = normalizeText(text);
  return terms.filter((term) => normalized.includes(normalizeText(term)));
}

class IdentityShiftDetector {
  detect({ memories = [], signals = [] } = {}) {
    if (!Array.isArray(memories) || memories.length === 0) {
      return this.emptyResult();
    }

    const memoryAnalyses = memories.map((memory) => {
      const memoryId = getMemoryId(memory);
      const text = buildMemoryText(memory);
      const beforeMarkers = extractMatchedTerms(text, BEFORE_MARKERS);
      const afterMarkers = extractMatchedTerms(text, AFTER_MARKERS);
      const transformationMarkers = extractMatchedTerms(text, TRANSFORMATION_MARKERS);
      const identityQualityMarkers = extractMatchedTerms(text, IDENTITY_QUALITY_MARKERS);
      const memorySignals = signals.filter((signal) => signal.memoryId === memoryId);

      const hasIdentitySignal = memorySignals.some((signal) => signal.type === StorySignalType.IDENTITY);
      const hasChangeSignal = memorySignals.some((signal) => signal.type === StorySignalType.CHANGE);
      const hasDecisionSignal = memorySignals.some((signal) => signal.type === StorySignalType.DECISION);

      return {
        memoryId,
        beforeMarkers,
        afterMarkers,
        transformationMarkers,
        identityQualityMarkers,
        hasIdentitySignal,
        hasChangeSignal,
        hasDecisionSignal,
        score: this.scoreMemory({
          beforeMarkers,
          afterMarkers,
          transformationMarkers,
          identityQualityMarkers,
          hasIdentitySignal,
          hasChangeSignal,
          hasDecisionSignal,
        }),
      };
    });

    const relatedMemories = memoryAnalyses
      .filter((analysis) => analysis.score >= 0.28)
      .map((analysis) => analysis.memoryId);

    const beforeMarkers = unique(memoryAnalyses.flatMap((analysis) => analysis.beforeMarkers));
    const afterMarkers = unique(memoryAnalyses.flatMap((analysis) => analysis.afterMarkers));
    const transformationMarkers = unique(memoryAnalyses.flatMap((analysis) => analysis.transformationMarkers));
    const identityQualityMarkers = unique(memoryAnalyses.flatMap((analysis) => analysis.identityQualityMarkers));

    const identitySignalCount = countSignalTypes(signals, [StorySignalType.IDENTITY]);
    const transformationSignalCount = countSignalTypes(signals, [
      StorySignalType.CHANGE,
      StorySignalType.DECISION,
      StorySignalType.ACHIEVEMENT,
      StorySignalType.VALUE,
    ]);

    const markerScore = clamp(
      (beforeMarkers.length * 0.12) +
      (afterMarkers.length * 0.16) +
      (transformationMarkers.length * 0.18) +
      (identityQualityMarkers.length * 0.08)
    );

    const signalScore = clamp((identitySignalCount * 0.22) + (transformationSignalCount * 0.09));
    const continuityScore = relatedMemories.length >= 2 ? 0.22 : relatedMemories.length === 1 ? 0.1 : 0;
    const score = clamp(markerScore + signalScore + continuityScore);

    const detected = score >= 0.45;

    return {
      detected,
      type: 'IDENTITY_SHIFT',
      score,
      confidence: score,
      relatedMemories,
      beforeMarkers,
      afterMarkers,
      transformationMarkers,
      identityQualityMarkers,
      summary: detected
        ? this.buildSummary({ beforeMarkers, afterMarkers, transformationMarkers, identityQualityMarkers })
        : 'Não há evidência suficiente de mudança de identidade.',
      mainQuestion: detected
        ? 'Quem o autor era antes, e quem ele parece estar se tornando?'
        : null,
      evidence: this.buildEvidence(memoryAnalyses),
    };
  }

  scoreMemory({
    beforeMarkers = [],
    afterMarkers = [],
    transformationMarkers = [],
    identityQualityMarkers = [],
    hasIdentitySignal = false,
    hasChangeSignal = false,
    hasDecisionSignal = false,
  } = {}) {
    return clamp(
      (beforeMarkers.length ? 0.12 : 0) +
      (afterMarkers.length ? 0.16 : 0) +
      (transformationMarkers.length ? 0.2 : 0) +
      (identityQualityMarkers.length ? 0.08 : 0) +
      (hasIdentitySignal ? 0.22 : 0) +
      (hasChangeSignal ? 0.14 : 0) +
      (hasDecisionSignal ? 0.08 : 0)
    );
  }

  buildSummary({ beforeMarkers = [], afterMarkers = [], transformationMarkers = [], identityQualityMarkers = [] } = {}) {
    const fragments = [];

    if (beforeMarkers.length) {
      fragments.push(`há sinais de estado anterior (${beforeMarkers.slice(0, 3).join(', ')})`);
    }

    if (afterMarkers.length) {
      fragments.push(`há sinais de estado posterior (${afterMarkers.slice(0, 3).join(', ')})`);
    }

    if (transformationMarkers.length) {
      fragments.push(`há linguagem de transformação (${transformationMarkers.slice(0, 3).join(', ')})`);
    }

    if (identityQualityMarkers.length) {
      fragments.push(`há qualidades identitárias emergentes (${identityQualityMarkers.slice(0, 3).join(', ')})`);
    }

    return `As memórias sugerem uma possível mudança de identidade: ${fragments.join('; ')}.`;
  }

  buildEvidence(memoryAnalyses = []) {
    return memoryAnalyses
      .filter((analysis) => analysis.score >= 0.28)
      .map((analysis) => ({
        memoryId: analysis.memoryId,
        detector: 'IdentityShiftDetector',
        score: analysis.score,
        reason: 'Esta memória contém sinais de estado anterior, estado posterior ou transformação de identidade.',
        markers: {
          before: analysis.beforeMarkers,
          after: analysis.afterMarkers,
          transformation: analysis.transformationMarkers,
          identityQualities: analysis.identityQualityMarkers,
        },
      }));
  }

  emptyResult() {
    return {
      detected: false,
      type: 'IDENTITY_SHIFT',
      score: 0,
      confidence: 0,
      relatedMemories: [],
      beforeMarkers: [],
      afterMarkers: [],
      transformationMarkers: [],
      identityQualityMarkers: [],
      summary: 'Nenhuma memória disponível para detectar mudança de identidade.',
      mainQuestion: null,
      evidence: [],
    };
  }
}

module.exports = {
  IdentityShiftDetector,
  BEFORE_MARKERS,
  AFTER_MARKERS,
  TRANSFORMATION_MARKERS,
  IDENTITY_QUALITY_MARKERS,
  clamp,
};
