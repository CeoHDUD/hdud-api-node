import { EVIDENCE_QUALITY } from '../contracts/truth-contract-version.js';

export class EvidenceQuality {
  constructor(value = EVIDENCE_QUALITY.NONE) {
    this.value = Object.values(EVIDENCE_QUALITY).includes(value) ? value : EVIDENCE_QUALITY.NONE;
  }

  static fromScore(score = 0) {
    if (score >= 85) return new EvidenceQuality(EVIDENCE_QUALITY.HIGH);
    if (score >= 65) return new EvidenceQuality(EVIDENCE_QUALITY.MEDIUM);
    if (score >= 35) return new EvidenceQuality(EVIDENCE_QUALITY.LOW);
    return new EvidenceQuality(EVIDENCE_QUALITY.NONE);
  }

  toJSON() {
    return this.value;
  }
}
