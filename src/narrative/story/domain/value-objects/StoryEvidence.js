function normalizeWeight(value) {
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

class StoryEvidence {
  constructor({
    evidenceId = null,
    storyId = null,
    memoryId,
    reason,
    weight = 0,
  }) {
    if (!memoryId) {
      throw new Error('StoryEvidence requires memoryId.');
    }

    if (!reason || typeof reason !== 'string') {
      throw new Error('StoryEvidence requires reason.');
    }

    this.evidenceId = evidenceId;
    this.storyId = storyId;
    this.memoryId = memoryId;
    this.reason = reason.trim();
    this.weight = normalizeWeight(weight);
  }

  toJSON() {
    return {
      evidenceId: this.evidenceId,
      storyId: this.storyId,
      memoryId: this.memoryId,
      reason: this.reason,
      weight: this.weight,
    };
  }
}

module.exports = {
  StoryEvidence,
  normalizeWeight,
};
