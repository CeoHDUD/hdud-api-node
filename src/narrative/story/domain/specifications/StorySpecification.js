class StorySpecification {
  isSatisfiedBy(story) {
    return Boolean(story && story.authorId && story.status);
  }
}
module.exports = { StorySpecification };
