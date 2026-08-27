const { IdentityShiftDetector } = require('../detectors/IdentityShiftDetector');
const { PurposeDetector } = require('../detectors/PurposeDetector');
const { ConflictDetector } = require('../detectors/ConflictDetector');
const { RelationshipEvolutionDetector } = require('../detectors/RelationshipEvolutionDetector');
const { EmotionalTransitionDetector } = require('../detectors/EmotionalTransitionDetector');
const { TurningPointDetector } = require('../detectors/TurningPointDetector');
const { RecurrenceDetector } = require('../detectors/RecurrenceDetector');
const { ConsequenceDetector } = require('../detectors/ConsequenceDetector');

class NarrativePatternEngine {
  constructor(detectors) {
    this.detectors = detectors || [
      new IdentityShiftDetector(),
      new PurposeDetector(),
      new ConflictDetector(),
      new RelationshipEvolutionDetector(),
      new EmotionalTransitionDetector(),
      new TurningPointDetector(),
      new ConsequenceDetector(),
    ];
    this.recurrenceDetector = new RecurrenceDetector();
  }

  analyze({ memories = [], signals = [] } = {}) {
    const memoryResults = [];
    for (const memory of memories) {
      const memoryId = memory.memoryId || memory.id || memory.memory_id;
      const memorySignals = signals.filter((signal) => signal.memoryId === memoryId || signal.memory_id === memoryId);
      const detections = this.detectors.map((detector) => detector.detect({ memory, signals: memorySignals }));
      memoryResults.push({ memoryId, detections });
    }

    const recurrence = this.recurrenceDetector.detect({ signals });
    const detected = memoryResults.flatMap((item) => item.detections).filter((d) => d.detected);
    const score = Math.min(1, (detected.reduce((sum, d) => sum + d.score, 0) / Math.max(1, detected.length || 1)) + (recurrence.score * 0.2));

    return {
      patternId: `pattern_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      score,
      detected: score >= 0.25 || detected.length >= 2,
      recurrence,
      memoryResults,
      dominantDetectors: this.getDominantDetectors(detected),
    };
  }

  getDominantDetectors(detections) {
    const map = new Map();
    for (const detection of detections) {
      const current = map.get(detection.detector) || { detector: detection.detector, score: 0, count: 0 };
      current.score += detection.score;
      current.count += 1;
      map.set(detection.detector, current);
    }
    return [...map.values()]
      .map((item) => ({ ...item, averageScore: item.score / item.count }))
      .sort((a, b) => b.averageScore - a.averageScore);
  }
}
module.exports = { NarrativePatternEngine };
