const { StorySignalType } = require('../value-objects/StorySignal');

const TRANSFORMATION_SIGNAL_TYPES = new Set([
  StorySignalType.CHANGE,
  StorySignalType.IDENTITY,
  StorySignalType.DECISION,
  StorySignalType.CONFLICT,
  StorySignalType.PURPOSE,
]);

class StoryDiscoveryPolicy {
  constructor({
    minimumSignals = 2,
    minimumTransformationSignals = 1,
    minimumAverageStrength = 0.35,
  } = {}) {
    this.minimumSignals = minimumSignals;
    this.minimumTransformationSignals = minimumTransformationSignals;
    this.minimumAverageStrength = minimumAverageStrength;
  }

  canDiscoverStory(signals = []) {
    if (!Array.isArray(signals) || signals.length < this.minimumSignals) {
      return false;
    }

    const transformationSignals = signals.filter((signal) => (
      TRANSFORMATION_SIGNAL_TYPES.has(signal.type)
    ));

    if (transformationSignals.length < this.minimumTransformationSignals) {
      return false;
    }

    const averageStrength = signals.reduce((sum, signal) => (
      sum + Number(signal.strength || 0)
    ), 0) / signals.length;

    return averageStrength >= this.minimumAverageStrength;
  }
}

module.exports = {
  StoryDiscoveryPolicy,
  TRANSFORMATION_SIGNAL_TYPES,
};
