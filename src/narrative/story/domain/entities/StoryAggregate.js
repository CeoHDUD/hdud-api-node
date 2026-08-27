class StoryAggregate {
  constructor({ story, evidence = [], signals = [] } = {}) {
    if (!story) throw new Error('StoryAggregate requires story.');
    this.story = story;
    this.evidence = evidence;
    this.signals = signals;
  }

  toJSON() {
    return {
      story: this.story.toJSON ? this.story.toJSON() : this.story,
      evidence: this.evidence.map((item) => item.toJSON ? item.toJSON() : item),
      signals: this.signals.map((item) => item.toJSON ? item.toJSON() : item),
    };
  }
}
module.exports = { StoryAggregate };
