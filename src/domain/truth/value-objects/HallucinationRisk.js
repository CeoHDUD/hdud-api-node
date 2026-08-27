import { HALLUCINATION_RISK } from '../contracts/truth-contract-version.js';

export class HallucinationRisk {
  constructor(value = HALLUCINATION_RISK.MEDIUM) {
    this.value = Object.values(HALLUCINATION_RISK).includes(value) ? value : HALLUCINATION_RISK.MEDIUM;
  }

  static fromTruthScore(score = 0) {
    if (score >= 92) return new HallucinationRisk(HALLUCINATION_RISK.VERY_LOW);
    if (score >= 78) return new HallucinationRisk(HALLUCINATION_RISK.LOW);
    if (score >= 58) return new HallucinationRisk(HALLUCINATION_RISK.MEDIUM);
    return new HallucinationRisk(HALLUCINATION_RISK.HIGH);
  }

  toJSON() {
    return this.value;
  }
}
