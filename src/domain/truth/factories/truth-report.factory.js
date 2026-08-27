import { TruthReport } from '../entities/TruthReport.js';

export function createTruthReport(payload = {}) {
  return new TruthReport(payload).toJSON();
}
