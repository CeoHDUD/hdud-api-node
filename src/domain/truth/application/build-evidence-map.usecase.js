import { buildEvidenceFromMemories } from '../services/evidence-builder.service.js';

export function buildEvidenceMapUseCase({ memories = [] } = {}) {
  const evidence = buildEvidenceFromMemories(memories);

  return {
    evidence_count: evidence.length,
    evidence: evidence.map((item) => item.toJSON()),
  };
}
