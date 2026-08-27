import { selectTruthMemories } from '../services/truth-memory-selection.service.js';
import { buildEvidenceFromMemories } from '../services/evidence-builder.service.js';
import { buildNarrativePayload } from '../services/narrative-payload-builder.service.js';
import { buildTruthPrompt } from '../services/truth-prompt-builder.service.js';
import { validateTruthResponse } from '../services/truth-validator.service.js';
import { validateConsistency } from '../services/consistency-validator.service.js';
import { buildEvidenceMap } from '../services/evidence-map.service.js';
import { calculateVersionQuality } from '../services/version-quality.service.js';
import { createTruthReport } from '../factories/truth-report.factory.js';

function safeJsonParse(value) {
  if (typeof value === 'object' && value !== null) return value;
  const clean = String(value || '').replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    return {
      title: 'História em revisão',
      manuscript: [],
      warnings: ['Resposta da IA não retornou JSON válido.'],
      raw_response: String(value || ''),
    };
  }
}

export async function buildStoryTruthUseCase({
  candidate,
  memories,
  previousVersions = [],
  generateWithAI,
  language = 'pt-BR',
} = {}) {
  if (!candidate) throw new Error('candidate is required');
  if (!Array.isArray(memories)) throw new Error('memories must be an array');

  const selection = selectTruthMemories(candidate, memories);
  const evidence = buildEvidenceFromMemories(selection.selectedMemories);
  const narrativePayload = buildNarrativePayload(evidence, candidate);
  const prompt = buildTruthPrompt({ narrativePayload, language });

  const aiRaw = typeof generateWithAI === 'function'
    ? await generateWithAI({ prompt, narrativePayload, evidence, candidate })
    : {
        title: candidate.title || 'História em revisão',
        manuscript: evidence.slice(0, 6).map((item, index) => ({
          paragraph_index: index + 1,
          text: item.excerpt,
          evidence_memory_ids: [item.memoryId],
          truth_notes: ['Parágrafo gerado em modo fallback a partir da própria evidência.'],
        })),
        warnings: ['IA não configurada; manuscrito fallback documental usado.'],
      };

  const aiResponse = safeJsonParse(aiRaw);
  const validation = validateTruthResponse(aiResponse, evidence);
  const consistency = validateConsistency({ currentResponse: aiResponse, previousVersions });
  const evidenceMap = buildEvidenceMap({ storyId: candidate.story_id || candidate.id, validation });
  const versionQuality = calculateVersionQuality({
    truthScore: validation.truth_score,
    narrativeQuality: 80,
    validation,
  });

  return createTruthReport({
    storyId: candidate.story_id || candidate.id || null,
    candidateId: candidate.candidate_id || candidate.id || null,
    truthScore: validation.truth_score,
    evidenceQuality: validation.evidence_quality,
    hallucinationRisk: validation.hallucination_risk,
    selectedMemories: selection.selectedMemories,
    discardedMemories: selection.discardedMemories,
    optionalMemories: selection.optionalMemories,
    warnings: [...(validation.warnings || []), ...(consistency.warnings || [])],
    validation: { ...validation, consistency, version_quality: versionQuality },
    evidenceMap,
    narrativePayload,
  });
}
