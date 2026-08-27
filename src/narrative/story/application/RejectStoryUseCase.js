const { createStoryEvent, StoryEventType } = require('../domain/events/StoryEvents');

class RejectStoryUseCase {
  async execute({ story, reason } = {}) {
    if (!story) throw new Error('RejectStoryUseCase.execute requires story.');
    const rejected = { ...story, rejected: true, authorValidation: { accepted: false, reason: reason || null } };
    return { story: rejected, event: createStoryEvent(StoryEventType.STORY_REJECTED, { storyId: story.storyId, reason }) };
  }
}
module.exports = { RejectStoryUseCase };
