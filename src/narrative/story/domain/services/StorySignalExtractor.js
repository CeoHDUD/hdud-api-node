const crypto = require('crypto');
const { StorySignal } = require('../value-objects/StorySignal');
const { runLexicalStoryDetectors } = require('../detectors/lexical-story-detectors');

function createSignalId() {
  return `signal_${crypto.randomUUID()}`;
}

function getMemoryId(memory = {}) {
  return memory.memoryId || memory.id || memory.memory_id || null;
}

function buildMemoryText(memory = {}) {
  return [
    memory.title,
    memory.content,
    memory.refined_content,
    memory.transcription,
    memory.lifePhase,
    memory.life_phase,
  ]
    .filter(Boolean)
    .join(' ');
}

class StorySignalExtractor {
  extractFromMemory(memory = {}) {
    const memoryId = getMemoryId(memory);

    if (!memoryId) {
      throw new Error('StorySignalExtractor.extractFromMemory requires memory id.');
    }

    const text = buildMemoryText(memory);
    const detectedSignals = runLexicalStoryDetectors(text);

    return detectedSignals.map((detector) => new StorySignal({
      signalId: createSignalId(),
      memoryId,
      type: detector.type,
      strength: detector.strength,
      source: detector.source,
    }));
  }

  extractFromMemories(memories = []) {
    if (!Array.isArray(memories)) {
      return [];
    }

    return memories.flatMap((memory) => this.extractFromMemory(memory));
  }

  explainMemory(memory = {}) {
    const text = buildMemoryText(memory);

    return runLexicalStoryDetectors(text).map((detector) => ({
      type: detector.type,
      strength: detector.strength,
      source: detector.source,
      reason: detector.reason,
    }));
  }
}

module.exports = {
  StorySignalExtractor,
  createSignalId,
  getMemoryId,
  buildMemoryText,
};
