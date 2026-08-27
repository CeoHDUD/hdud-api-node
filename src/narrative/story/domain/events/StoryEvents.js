const StoryEventType = Object.freeze({
  STORY_HYPOTHESIS_DISCOVERED: 'story_hypothesis_discovered',
  STORY_VALIDATED: 'story_validated',
  STORY_REJECTED: 'story_rejected',
  STORY_REFINED: 'story_refined',
});

function createStoryEvent(type, payload = {}) {
  return {
    type,
    payload,
    occurredAt: new Date().toISOString(),
  };
}
module.exports = { StoryEventType, createStoryEvent };
