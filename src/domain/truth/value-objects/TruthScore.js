export class TruthScore {
  constructor(value = 0) {
    const n = Number(value);
    this.value = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  }

  static fromSignals(signals = {}) {
    const base = 100;
    const penalties =
      (signals.unsupportedClaims || 0) * 12 +
      (signals.weakEvidence || 0) * 6 +
      (signals.contradictions || 0) * 10 +
      (signals.invalidClaims || 0) * 15;

    return new TruthScore(base - penalties);
  }

  label() {
    if (this.value >= 90) return 'Excellent';
    if (this.value >= 75) return 'Good';
    if (this.value >= 55) return 'Needs Review';
    return 'High Risk';
  }

  toJSON() {
    return { value: this.value, label: this.label() };
  }
}
