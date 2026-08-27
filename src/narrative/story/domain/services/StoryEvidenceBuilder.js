const crypto = require('crypto');
const { StoryEvidence } = require('../value-objects/StoryEvidence');

class StoryEvidenceBuilder {
  buildFromPattern(pattern = {}) {
    const evidence = [];
    for (const item of pattern.memoryResults || []) {
      for (const detection of item.detections || []) {
        if (!detection.detected) continue;
        evidence.push(new StoryEvidence({
          evidenceId: `evidence_${crypto.randomUUID()}`,
          storyId: null,
          memoryId: item.memoryId,
          reason: detection.reason || detection.detector,
          weight: Math.max(0.1, Math.min(1, detection.score || 0.1)),
        }));
      }
    }
    return evidence;
  }
}
module.exports = { StoryEvidenceBuilder };
