export class TruthReport {
  constructor({
    storyId = null,
    candidateId = null,
    truthScore = 0,
    evidenceQuality = 'NONE',
    hallucinationRisk = 'MEDIUM',
    selectedMemories = [],
    discardedMemories = [],
    optionalMemories = [],
    warnings = [],
    validation = null,
    evidenceMap = null,
    narrativePayload = '',
  } = {}) {
    this.storyId = storyId;
    this.candidateId = candidateId;
    this.truthScore = truthScore;
    this.evidenceQuality = evidenceQuality;
    this.hallucinationRisk = hallucinationRisk;
    this.selectedMemories = selectedMemories;
    this.discardedMemories = discardedMemories;
    this.optionalMemories = optionalMemories;
    this.warnings = warnings;
    this.validation = validation;
    this.evidenceMap = evidenceMap;
    this.narrativePayload = narrativePayload;
  }

  canPublish() {
    return this.truthScore >= 70 && this.hallucinationRisk !== 'HIGH';
  }

  toJSON() {
    return {
      story_id: this.storyId,
      candidate_id: this.candidateId,
      truth_score: this.truthScore,
      evidence_quality: this.evidenceQuality,
      hallucination_risk: this.hallucinationRisk,
      can_publish: this.canPublish(),
      selected_memories: this.selectedMemories,
      discarded_memories: this.discardedMemories,
      optional_memories: this.optionalMemories,
      warnings: this.warnings,
      validation: this.validation,
      evidence_map: this.evidenceMap,
      narrative_payload: this.narrativePayload,
    };
  }
}
