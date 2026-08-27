class StoryRankingEngine {
  rank(hypotheses = []) {
    return [...hypotheses].sort((a, b) => {
      const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (confidenceDiff !== 0) return confidenceDiff;
      return (b.relatedMemories || []).length - (a.relatedMemories || []).length;
    });
  }
}
module.exports = { StoryRankingEngine };
