const { toStoryHypothesisDTO } = require('./story-dto');
const StoryHypothesisContractVersion = 'story-hypothesis.v1.0';

function buildStoryHypothesisContract(hypothesis = {}) {
  return {
    contractVersion: StoryHypothesisContractVersion,
    ...toStoryHypothesisDTO(hypothesis),
  };
}

function buildStoryHypothesisResponse(hypotheses = []) {
  return {
    contractVersion: StoryHypothesisContractVersion,
    count: hypotheses.length,
    hypotheses: hypotheses.map(buildStoryHypothesisContract),
  };
}
module.exports = { StoryHypothesisContractVersion, buildStoryHypothesisContract, buildStoryHypothesisResponse };
