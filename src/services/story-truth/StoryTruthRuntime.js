export class StoryTruthRuntime {
  constructor({ persistence }) {
    if (!persistence) throw new Error('StoryTruthRuntime requires persistence');
    this.persistence = persistence;
  }

  async persist(context) {
    if (!context.truthReport) {
      throw new Error('StoryTruthRuntime cannot persist without truthReport');
    }

    if (!context.manuscript) {
      throw new Error('StoryTruthRuntime cannot persist empty manuscript');
    }

    return this.persistence.saveAll({ context });
  }
}
