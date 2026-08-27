import { TRUTH_CONTRACT_VERSION } from './truth-contract-version.js';

export function buildTruthContract(payload = {}) {
  return {
    contract: 'HDUD_TRUTH_DOMAIN',
    version: TRUTH_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    ...payload,
  };
}
