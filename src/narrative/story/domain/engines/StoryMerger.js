class StoryMerger {
  mergeSimilar(hypotheses = []) {
    const byQuestion = new Map();
    for (const hypothesis of hypotheses) {
      const key = (hypothesis.mainQuestion || hypothesis.centralQuestion || hypothesis.title || 'story').toLowerCase();
      const current = byQuestion.get(key);
      if (!current) {
        byQuestion.set(key, { ...hypothesis });
        continue;
      }
      current.relatedMemories = [...new Set([...(current.relatedMemories || []), ...(hypothesis.relatedMemories || [])])];
      current.confidence = Math.max(current.confidence || 0, hypothesis.confidence || 0);
      current.evidence = [...(current.evidence || []), ...(hypothesis.evidence || [])];
    }
    return [...byQuestion.values()];
  }
}
module.exports = { StoryMerger };
