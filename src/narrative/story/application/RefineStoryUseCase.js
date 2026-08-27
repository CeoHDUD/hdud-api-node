const { createStoryEvent, StoryEventType } = require('../domain/events/StoryEvents');

class RefineStoryUseCase {
  async execute({ story, refinement = {} } = {}) {
    if (!story) throw new Error('RefineStoryUseCase.execute requires story.');
    const refined = { ...story, ...refinement, refinedAt: new Date().toISOString() };
    return { story: refined, event: createStoryEvent(StoryEventType.STORY_REFINED, { storyId: story.storyId, refinement }) };
  }
}
module.exports = { RefineStoryUseCase };
