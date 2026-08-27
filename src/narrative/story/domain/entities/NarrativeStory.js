const { StoryStatus, isValidStoryStatus } = require('../value-objects/StoryStatus');

function normalizeConfidence(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  if (numericValue < 0) {
    return 0;
  }

  if (numericValue > 1) {
    return 1;
  }

  return numericValue;
}

class NarrativeStory {
  constructor({
    storyId = null,
    authorId,
    status = StoryStatus.DISCOVERING,
    centralTheme = '',
    centralQuestion = '',
    summary = '',
    confidence = 0,
    relatedMemories = [],
    evidence = [],
    mainTransformation = '',
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  }) {
    if (!authorId) {
      throw new Error('NarrativeStory requires authorId.');
    }

    if (!isValidStoryStatus(status)) {
      throw new Error(`Invalid NarrativeStory status: ${status}`);
    }

    this.storyId = storyId;
    this.authorId = authorId;
    this.status = status;
    this.centralTheme = centralTheme;
    this.centralQuestion = centralQuestion;
    this.summary = summary;
    this.confidence = normalizeConfidence(confidence);
    this.relatedMemories = Array.isArray(relatedMemories) ? relatedMemories : [];
    this.evidence = Array.isArray(evidence) ? evidence : [];
    this.mainTransformation = mainTransformation;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  isMature() {
    return this.status === StoryStatus.MATURE
      || this.status === StoryStatus.VALIDATED
      || this.status === StoryStatus.EDITORIAL_READY;
  }

  canBecomeChapter() {
    return this.status === StoryStatus.EDITORIAL_READY;
  }

  toHypothesis() {
    return {
      storyId: this.storyId,
      status: this.status,
      confidence: this.confidence,
      title: this.centralTheme,
      summary: this.summary,
      relatedMemories: this.relatedMemories,
      mainTransformation: this.mainTransformation,
      mainQuestion: this.centralQuestion,
      evidence: this.evidence,
    };
  }

  toJSON() {
    return {
      storyId: this.storyId,
      authorId: this.authorId,
      status: this.status,
      centralTheme: this.centralTheme,
      centralQuestion: this.centralQuestion,
      summary: this.summary,
      confidence: this.confidence,
      relatedMemories: this.relatedMemories,
      evidence: this.evidence,
      mainTransformation: this.mainTransformation,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = {
  NarrativeStory,
  normalizeConfidence,
};
