export class StoryLineage {
  constructor({ storyId = null, versionId = null, previousVersionId = null, changes = [], evidenceDelta = {} } = {}) {
    this.storyId = storyId;
    this.versionId = versionId;
    this.previousVersionId = previousVersionId;
    this.changes = Array.isArray(changes) ? changes : [];
    this.evidenceDelta = evidenceDelta || {};
    this.createdAt = new Date().toISOString();
  }

  toJSON() {
    return {
      story_id: this.storyId,
      version_id: this.versionId,
      previous_version_id: this.previousVersionId,
      changes: this.changes,
      evidence_delta: this.evidenceDelta,
      created_at: this.createdAt,
    };
  }
}
