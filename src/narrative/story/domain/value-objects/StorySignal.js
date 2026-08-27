const StorySignalType = Object.freeze({
  EMOTION: 'EMOTION',
  RELATIONSHIP: 'RELATIONSHIP',
  PURPOSE: 'PURPOSE',
  CONFLICT: 'CONFLICT',
  DECISION: 'DECISION',
  LOSS: 'LOSS',
  ACHIEVEMENT: 'ACHIEVEMENT',
  CHANGE: 'CHANGE',
  VALUE: 'VALUE',
  IDENTITY: 'IDENTITY',
});

function normalizeStrength(value) {
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

class StorySignal {
  constructor({
    signalId = null,
    memoryId,
    type,
    strength = 0,
    source = 'heuristic',
    createdAt = new Date().toISOString(),
  }) {
    if (!memoryId) {
      throw new Error('StorySignal requires memoryId.');
    }

    if (!Object.values(StorySignalType).includes(type)) {
      throw new Error(`Invalid StorySignal type: ${type}`);
    }

    this.signalId = signalId;
    this.memoryId = memoryId;
    this.type = type;
    this.strength = normalizeStrength(strength);
    this.source = source;
    this.createdAt = createdAt;
  }

  toJSON() {
    return {
      signalId: this.signalId,
      memoryId: this.memoryId,
      type: this.type,
      strength: this.strength,
      source: this.source,
      createdAt: this.createdAt,
    };
  }
}

module.exports = {
  StorySignal,
  StorySignalType,
  normalizeStrength,
};
