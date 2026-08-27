export const TRUTH_CONTRACT_VERSION = '1.0.0';

export const TRUTH_DECISION = Object.freeze({
  KEEP: 'KEEP',
  DROP: 'DROP',
  OPTIONAL: 'OPTIONAL',
});

export const TRUTH_STATUS = Object.freeze({
  VALID: 'VALID',
  WARNING: 'WARNING',
  INVALID: 'INVALID',
});

export const EVIDENCE_QUALITY = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  NONE: 'NONE',
});

export const HALLUCINATION_RISK = Object.freeze({
  VERY_LOW: 'VERY_LOW',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});
