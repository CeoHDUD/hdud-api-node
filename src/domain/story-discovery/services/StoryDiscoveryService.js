const crypto = require('crypto');
const { NarrativeStory } = require('../entities/NarrativeStory');
const { StoryStatus } = require('../value-objects/StoryStatus');
const { StoryEvidence } = require('../value-objects/StoryEvidence');
const { StoryDiscoveryPolicy } = require('../policies/StoryDiscoveryPolicy');
const { StorySignalExtractor, getMemoryId } = require('./StorySignalExtractor');
const { LEXICAL_STORY_DETECTORS } = require('../detectors/lexical-story-detectors');
const { IdentityShiftDetector } = require('../detectors/IdentityShiftDetector');

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function buildEvidenceReason(signalType) {
  const detector = LEXICAL_STORY_DETECTORS.find((item) => item.type === signalType);
  return detector?.reason || `Esta memória apresenta sinal narrativo do tipo ${signalType}.`;
}

function truthScoreMemory(memory, signals = []) {
  const content = String(memory?.content || memory?.description || memory?.summary || '');
  let score = 0;
  const reasons = [];

  if (signals.length) {
    score += Math.min(35, signals.length * 10);
    reasons.push('story_signals');
  }

  if (content.length >= 300) {
    score += 20;
    reasons.push('rich_content');
  }

  if (/\b(18|19|20|21)\d{2}\b/.test(content)) {
    score += 20;
    reasons.push('temporal_evidence');
  }

  if (memory?.title) {
    score += 10;
    reasons.push('title');
  }

  const normalized = Math.max(0, Math.min(100, Math.round(score)));
  const decision = normalized >= 70 ? 'KEEP' : normalized >= 50 ? 'OPTIONAL' : 'DROP';

  return {
    memory_id: getMemoryId(memory),
    truth_score: normalized,
    truth_decision: decision,
    reasons,
  };
}

function buildTruthSelection(enrichedMemories = []) {
  const scored = enrichedMemories.map((item) => ({
    ...item,
    truth: truthScoreMemory(item.memory, item.signals),
  }));

  const keep = scored.filter((item) => item.truth.truth_decision === 'KEEP');
  const optional = scored.filter((item) => item.truth.truth_decision === 'OPTIONAL');
  const drop = scored.filter((item) => item.truth.truth_decision === 'DROP');

  return {
    keep,
    optional,
    drop,
    statistics: {
      total: scored.length,
      keep: keep.length,
      optional: optional.length,
      drop: drop.length,
    },
  };
}

class StoryDiscoveryService {
  constructor({
    policy = new StoryDiscoveryPolicy(),
    signalExtractor = new StorySignalExtractor(),
    identityShiftDetector = new IdentityShiftDetector(),
  } = {}) {
    this.policy = policy;
    this.signalExtractor = signalExtractor;
    this.identityShiftDetector = identityShiftDetector;
  }

  extractSignals(memory) {
    return this.signalExtractor.extractFromMemory(memory);
  }

  buildEvidence(memory, signals) {
    const memoryId = getMemoryId(memory);

    return signals.map((signal) => new StoryEvidence({
      evidenceId: createId('evidence'),
      memoryId,
      reason: buildEvidenceReason(signal.type),
      weight: signal.strength,
    }).toJSON());
  }

  discoverStories({ authorId, memories = [] }) {
    if (!authorId) {
      throw new Error('StoryDiscoveryService.discoverStories requires authorId.');
    }

    if (!Array.isArray(memories) || memories.length === 0) {
      return [];
    }

    const enrichedMemories = memories.map((memory) => {
      const signals = this.extractSignals(memory);
      return {
        memory,
        signals,
        evidence: this.buildEvidence(memory, signals),
      };
    });

    const policyCandidateMemories = enrichedMemories.filter(({ signals }) => (
      this.policy.canDiscoverStory(signals)
    ));

    const truthSelection = buildTruthSelection(policyCandidateMemories);
    const candidateMemories = truthSelection.keep.length >= 2
      ? truthSelection.keep
      : [...truthSelection.keep, ...truthSelection.optional].slice(0, Math.max(2, truthSelection.keep.length + truthSelection.optional.length));

    if (candidateMemories.length === 0) {
      return [];
    }

    const allSignals = candidateMemories.flatMap(({ signals }) => signals);
    const allEvidence = candidateMemories.flatMap(({ evidence }) => evidence);
    const identityShift = this.identityShiftDetector.detect({
      memories: candidateMemories.map(({ memory }) => memory),
      signals: allSignals,
    });
    const signalConfidence = allSignals.reduce((sum, signal) => (
      sum + signal.strength
    ), 0) / allSignals.length;
    const averageConfidence = identityShift.detected
      ? ((signalConfidence * 0.55) + (identityShift.confidence * 0.45))
      : signalConfidence;

    const relatedMemories = candidateMemories.map(({ memory }) => getMemoryId(memory));
    const truthScores = candidateMemories.map((item) => item.truth.truth_score);
    const averageTruthScore = truthScores.length
      ? Math.round(truthScores.reduce((sum, score) => sum + score, 0) / truthScores.length)
      : 0;

    const status = averageConfidence >= 0.8
      ? StoryStatus.MATURE
      : StoryStatus.EMERGING;

    const story = new NarrativeStory({
      storyId: createId('story'),
      authorId,
      status,
      confidence: averageConfidence,
      centralTheme: identityShift.detected ? 'Mudança de identidade' : 'Hipótese de transformação humana',
      centralQuestion: identityShift.mainQuestion || 'Que mudança importante estas memórias parecem revelar?',
      summary: identityShift.detected
        ? identityShift.summary
        : 'Estas memórias apresentam sinais narrativos suficientes para formar uma hipótese inicial de história humana.',
      relatedMemories,
      evidence: [
        ...allEvidence,
        ...identityShift.evidence,
      ],
      mainTransformation: identityShift.detected
        ? 'Possível mudança de identidade detectada'
        : 'Transformação ainda em descoberta',
    });

    return [{
      ...story.toHypothesis(),
      story_state: 'STORY_TRUTH_CANDIDATE',
      truth_score: averageTruthScore,
      evidence_quality: averageTruthScore >= 85 ? 'HIGH' : averageTruthScore >= 65 ? 'MEDIUM' : averageTruthScore >= 40 ? 'LOW' : 'NONE',
      hallucination_risk: averageTruthScore >= 90 ? 'VERY_LOW' : averageTruthScore >= 75 ? 'LOW' : averageTruthScore >= 55 ? 'MEDIUM' : 'HIGH',
      truth_selection: {
        selected: truthSelection.keep.map((item) => item.truth),
        optional: truthSelection.optional.map((item) => item.truth),
        discarded: truthSelection.drop.map((item) => item.truth),
        statistics: truthSelection.statistics,
        source_policy: 'Story Discovery Service aplicou Truth Memory Selection antes da hipótese narrativa.',
      },
    }];
  }
}

module.exports = {
  StoryDiscoveryService,
};
