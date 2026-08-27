const crypto = require('crypto');
const { NarrativeStory } = require('../entities/NarrativeStory');
const { StoryStatus } = require('../value-objects/StoryStatus');

class StoryFactory {
  createFromHypothesis({ authorId, hypothesis = {} } = {}) {
    return new NarrativeStory({
      storyId: hypothesis.storyId || `story_${crypto.randomUUID()}`,
      authorId,
      status: hypothesis.status || StoryStatus.EMERGING,
      centralTheme: hypothesis.title || hypothesis.centralTheme || 'História em descoberta',
      centralQuestion: hypothesis.mainQuestion || hypothesis.centralQuestion || 'Que transformação está acontecendo aqui?',
      summary: hypothesis.summary || '',
      confidence: hypothesis.confidence || 0,
    });
  }
}
module.exports = { StoryFactory };
