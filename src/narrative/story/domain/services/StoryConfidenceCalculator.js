class StoryConfidenceCalculator {
  calculate({ pattern = {}, evidence = [], relatedMemories = [] } = {}) {
    const patternScore = Number(pattern.score || 0);
    const evidenceScore = Math.min(1, evidence.reduce((sum, item) => sum + Number(item.weight || 0), 0) / 4);
    const memoryScore = Math.min(1, relatedMemories.length * 0.18);
    return Math.max(0, Math.min(1, (patternScore * 0.45) + (evidenceScore * 0.35) + (memoryScore * 0.2)));
  }
}
module.exports = { StoryConfidenceCalculator };
