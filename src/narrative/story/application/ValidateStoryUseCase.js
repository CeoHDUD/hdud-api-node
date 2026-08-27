const { StoryStatus } = require('../domain/value-objects/StoryStatus');
const { createStoryEvent, StoryEventType } = require('../domain/events/StoryEvents');

class ValidateStoryUseCase {
  async execute({ story, authorNote } = {}) {
    if (!story) throw new Error('ValidateStoryUseCase.execute requires story.');
    const validated = { ...story, status: StoryStatus.VALIDATED, authorValidation: { accepted: true, note: authorNote || null } };
    return { story: validated, event: createStoryEvent(StoryEventType.STORY_VALIDATED, { storyId: story.storyId, authorNote }) };
  }
}
module.exports = { ValidateStoryUseCase };
