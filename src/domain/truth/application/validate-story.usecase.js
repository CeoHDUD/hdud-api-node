import { buildEvidenceFromMemories } from '../services/evidence-builder.service.js';
import { validateTruthResponse } from '../services/truth-validator.service.js';
import { buildEvidenceMap } from '../services/evidence-map.service.js';

export function validateStoryUseCase({ storyId = null, aiResponse = {}, memories = [] } = {}) {
  const evidence = buildEvidenceFromMemories(memories);
  const validation = validateTruthResponse(aiResponse, evidence);
  const evidenceMap = buildEvidenceMap({ storyId, validation });

  return {
    story_id: storyId,
    validation,
    evidence_map: evidenceMap,
  };
}
