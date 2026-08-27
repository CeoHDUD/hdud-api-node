const { StoryDiscoveryOrchestrator } = require('../domain/services/StoryDiscoveryOrchestrator');
const { buildStoryHypothesisResponse } = require('../contracts/story-contract');

class DiscoverStoriesUseCase {
  constructor(dependencies = {}) {
    this.memoryProvider = dependencies.memoryProvider || null;
    this.orchestrator = dependencies.orchestrator || new StoryDiscoveryOrchestrator(dependencies);
  }

  async execute({ authorId, memories } = {}) {
    if (!authorId) throw new Error('DiscoverStoriesUseCase.execute requires authorId.');
    const sourceMemories = Array.isArray(memories)
      ? memories
      : this.memoryProvider
        ? await this.memoryProvider.findByAuthorId(authorId)
        : [];
    const hypotheses = this.orchestrator.discover({ authorId, memories: sourceMemories });
    return buildStoryHypothesisResponse(hypotheses);
  }
}
module.exports = { DiscoverStoriesUseCase };
