const { DiscoverStoriesUseCase } = require('../application/DiscoverStoriesUseCase');
const { ValidateStoryUseCase } = require('../application/ValidateStoryUseCase');
const { RejectStoryUseCase } = require('../application/RejectStoryUseCase');
const { RefineStoryUseCase } = require('../application/RefineStoryUseCase');
const { StoryDiscoveryOrchestrator } = require('../domain/services/StoryDiscoveryOrchestrator');
const { StoryDiscoveryService } = require('../domain/services/StoryDiscoveryService');
const { StorySignalExtractor } = require('../domain/services/StorySignalExtractor');
const { StoryEvidenceBuilder } = require('../domain/services/StoryEvidenceBuilder');
const { StoryConfidenceCalculator } = require('../domain/services/StoryConfidenceCalculator');
const { NarrativePatternEngine } = require('../domain/engines/NarrativePatternEngine');
const { StoryRankingEngine } = require('../domain/engines/StoryRankingEngine');
const { StoryMerger } = require('../domain/engines/StoryMerger');
const { StorySplitter } = require('../domain/engines/StorySplitter');
const { StoryFactory } = require('../domain/factories/StoryFactory');
const { StoryRepository } = require('../domain/repositories/StoryRepository');
const { StorySpecification } = require('../domain/specifications/StorySpecification');
const { StoryEventType, createStoryEvent } = require('../domain/events/StoryEvents');
const { StoryResult } = require('../domain/result/StoryResult');
const { NarrativeStory } = require('../domain/entities/NarrativeStory');
const { StoryAggregate } = require('../domain/entities/StoryAggregate');
const { StoryStatus } = require('../domain/value-objects/StoryStatus');
const { StorySignal, StorySignalType } = require('../domain/value-objects/StorySignal');
const { StoryEvidence } = require('../domain/value-objects/StoryEvidence');
const { StoryDiscoveryPolicy } = require('../domain/policies/StoryDiscoveryPolicy');
const { PurposeDetector } = require('../domain/detectors/PurposeDetector');
const { ConflictDetector } = require('../domain/detectors/ConflictDetector');
const { RelationshipEvolutionDetector } = require('../domain/detectors/RelationshipEvolutionDetector');
const { EmotionalTransitionDetector } = require('../domain/detectors/EmotionalTransitionDetector');
const { TurningPointDetector } = require('../domain/detectors/TurningPointDetector');
const { RecurrenceDetector } = require('../domain/detectors/RecurrenceDetector');
const { ConsequenceDetector } = require('../domain/detectors/ConsequenceDetector');
const { IdentityShiftDetector } = require('../domain/detectors/IdentityShiftDetector');
const { StoryHypothesisContractVersion, buildStoryHypothesisContract, buildStoryHypothesisResponse } = require('../contracts/story-contract');

function createNarrativeStoryEngine(dependencies = {}) {
  const orchestrator = new StoryDiscoveryOrchestrator(dependencies);
  return {
    discoverStories: ({ authorId, memories }) => orchestrator.discover({ authorId, memories }),
    orchestrator,
  };
}

module.exports = {
  createNarrativeStoryEngine,
  DiscoverStoriesUseCase,
  ValidateStoryUseCase,
  RejectStoryUseCase,
  RefineStoryUseCase,
  StoryDiscoveryOrchestrator,
  StoryDiscoveryService,
  StorySignalExtractor,
  StoryEvidenceBuilder,
  StoryConfidenceCalculator,
  NarrativePatternEngine,
  StoryRankingEngine,
  StoryMerger,
  StorySplitter,
  StoryFactory,
  StoryRepository,
  StorySpecification,
  StoryEventType,
  createStoryEvent,
  StoryResult,
  NarrativeStory,
  StoryAggregate,
  StoryStatus,
  StorySignal,
  StorySignalType,
  StoryEvidence,
  StoryDiscoveryPolicy,
  IdentityShiftDetector,
  PurposeDetector,
  ConflictDetector,
  RelationshipEvolutionDetector,
  EmotionalTransitionDetector,
  TurningPointDetector,
  RecurrenceDetector,
  ConsequenceDetector,
  StoryHypothesisContractVersion,
  buildStoryHypothesisContract,
  buildStoryHypothesisResponse,
};
