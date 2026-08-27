export class StoryTruthContext {
  constructor({
    storyId,
    authorId,
    candidate = null,
    memories = [],
    previousVersions = [],
    language = 'pt-BR',
    requestId = null,
  }) {
    if (!storyId) throw new Error('StoryTruthContext requires storyId');
    if (!authorId) throw new Error('StoryTruthContext requires authorId');

    this.storyId = Number(storyId);
    this.authorId = Number(authorId);
    this.requestId = requestId || `story_truth_${this.storyId}_${Date.now()}`;
    this.language = language;

    this.candidate = candidate;
    this.memories = memories;
    this.previousVersions = previousVersions;

    this.selection = null;
    this.evidence = [];
    this.narrativePayload = '';
    this.prompt = '';
    this.openaiResponse = null;
    this.validation = null;
    this.evidenceMap = null;
    this.truthReport = null;
    this.lineage = null;
    this.version = null;
    this.manuscript = null;
    this.warnings = [];
  }

  addWarning(message, metadata = {}) {
    this.warnings.push({
      message,
      metadata,
      created_at: new Date().toISOString(),
    });
  }

  toJSON() {
    return {
      story_id: this.storyId,
      author_id: this.authorId,
      request_id: this.requestId,
      language: this.language,
      candidate: this.candidate,
      memories_count: this.memories.length,
      selection: this.selection,
      evidence_count: this.evidence.length,
      narrative_payload: this.narrativePayload,
      prompt: this.prompt,
      openai_response: this.openaiResponse,
      validation: this.validation,
      evidence_map: this.evidenceMap,
      truth_report: this.truthReport,
      lineage: this.lineage,
      version: this.version,
      manuscript: this.manuscript,
      warnings: this.warnings,
    };
  }
}
