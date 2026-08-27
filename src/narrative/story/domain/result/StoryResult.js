class StoryResult {
  static ok(value) { return { ok: true, value, error: null }; }
  static fail(error) { return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) }; }
}
module.exports = { StoryResult };
