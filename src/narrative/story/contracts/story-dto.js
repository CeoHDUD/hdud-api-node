function toStoryHypothesisDTO(hypothesis = {}) {
  return {
    storyId: hypothesis.storyId,
    authorId: hypothesis.authorId,
    status: hypothesis.status,
    confidence: hypothesis.confidence,
    title: hypothesis.title,
    summary: hypothesis.summary,
    relatedMemories: hypothesis.relatedMemories || [],
    mainTransformation: hypothesis.mainTransformation,
    mainQuestion: hypothesis.mainQuestion,
    evidence: (hypothesis.evidence || []).map((item) => item.toJSON ? item.toJSON() : item),
  };
}
module.exports = { toStoryHypothesisDTO };
