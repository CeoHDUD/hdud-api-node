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

    const candidateMemories = enrichedMemories.filter(({ signals }) => (
      this.policy.canDiscoverStory(signals)
    ));

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

    return [story.toHypothesis()];
  }
}

module.exports = {
  StoryDiscoveryService,
};
