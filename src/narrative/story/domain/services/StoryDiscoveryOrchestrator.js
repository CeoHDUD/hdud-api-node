const crypto = require('crypto');
const { StorySignalExtractor } = require('./StorySignalExtractor');
const { NarrativePatternEngine } = require('../engines/NarrativePatternEngine');
const { StoryEvidenceBuilder } = require('./StoryEvidenceBuilder');
const { StoryConfidenceCalculator } = require('./StoryConfidenceCalculator');
const { StoryRankingEngine } = require('../engines/StoryRankingEngine');
const { StoryMerger } = require('../engines/StoryMerger');
const { StorySplitter } = require('../engines/StorySplitter');
const { StoryStatus } = require('../value-objects/StoryStatus');

class StoryDiscoveryOrchestrator {
  constructor(dependencies = {}) {
    this.signalExtractor = dependencies.signalExtractor || new StorySignalExtractor();
    this.patternEngine = dependencies.patternEngine || new NarrativePatternEngine();
    this.evidenceBuilder = dependencies.evidenceBuilder || new StoryEvidenceBuilder();
    this.confidenceCalculator = dependencies.confidenceCalculator || new StoryConfidenceCalculator();
    this.rankingEngine = dependencies.rankingEngine || new StoryRankingEngine();
    this.merger = dependencies.merger || new StoryMerger();
    this.splitter = dependencies.splitter || new StorySplitter();
  }

  discover({ authorId, memories = [] } = {}) {
    if (!authorId) throw new Error('StoryDiscoveryOrchestrator.discover requires authorId.');
    if (!Array.isArray(memories)) return [];

    const signals = this.signalExtractor.extractFromMemories(memories);
    const pattern = this.patternEngine.analyze({ memories, signals });
    if (!pattern.detected) return [];

    const evidence = this.evidenceBuilder.buildFromPattern(pattern);
    const relatedMemories = [...new Set(evidence.map((item) => item.memoryId).filter(Boolean))];
    const confidence = this.confidenceCalculator.calculate({ pattern, evidence, relatedMemories });
    const title = this.deriveTitle(pattern);
    const hypothesis = {
      storyId: `story_${crypto.randomUUID()}`,
      authorId,
      status: confidence >= 0.72 ? StoryStatus.MATURE : StoryStatus.EMERGING,
      confidence,
      title,
      summary: this.deriveSummary(pattern, relatedMemories),
      relatedMemories,
      mainTransformation: this.deriveTransformation(pattern),
      mainQuestion: this.deriveQuestion(pattern),
      evidence,
      pattern,
    };

    const split = this.splitter.splitIfNeeded(hypothesis);
    return this.rankingEngine.rank(this.merger.mergeSimilar(split));
  }

  deriveTitle(pattern) {
    const top = (pattern.dominantDetectors || [])[0]?.detector || 'NarrativePattern';
    const map = {
      IdentityShiftDetector: 'Uma mudança na forma de se reconhecer',
      PurposeDetector: 'A descoberta de um propósito',
      ConflictDetector: 'Uma travessia de conflito',
      RelationshipEvolutionDetector: 'Uma relação em transformação',
      EmotionalTransitionDetector: 'Uma passagem emocional',
      TurningPointDetector: 'Um ponto de virada',
      ConsequenceDetector: 'Uma consequência que mudou o caminho',
    };
    return map[top] || 'Uma história começando a aparecer';
  }

  deriveSummary(pattern, relatedMemories) {
    return `A engine encontrou ${relatedMemories.length} memória(s) com sinais consistentes de transformação narrativa.`;
  }

  deriveTransformation(pattern) {
    const top = (pattern.dominantDetectors || [])[0]?.detector || 'NarrativePattern';
    return top.replace('Detector', '');
  }

  deriveQuestion(pattern) {
    const transformation = this.deriveTransformation(pattern);
    return `Que mudança humana está sendo revelada por ${transformation}?`;
  }
}
module.exports = { StoryDiscoveryOrchestrator };
