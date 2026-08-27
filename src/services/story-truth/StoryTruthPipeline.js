import {
  buildStoryTruthUseCase,
  AuthorSovereigntyPolicy,
} from '../../domain/truth/index.js';
import { buildStoryLineage } from '../../domain/truth/services/story-lineage.service.js';
import { selectTruthMemories } from './truth-memory-selection.service.js';
import { buildTruthSelectionReport } from './truth-selection-report.service.js';

function manuscriptFromTruthReport(report = {}) {
  const paragraphs = report.validation?.paragraphs || [];
  if (!paragraphs.length) return '';

  return paragraphs
    .sort((a, b) => Number(a.paragraph_index) - Number(b.paragraph_index))
    .map((paragraph) => paragraph.paragraph_text)
    .join('\n\n');
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function extractCandidateMemoryIds(candidate = {}) {
  const direct = [
    ...(Array.isArray(candidate.memoryIds) ? candidate.memoryIds : []),
    ...(Array.isArray(candidate.memory_ids) ? candidate.memory_ids : []),
    ...(Array.isArray(candidate.memories) ? candidate.memories.map((memory) => memory?.memory_id ?? memory?.id) : []),
    ...(Array.isArray(candidate.related_memories) ? candidate.related_memories.map((memory) => memory?.memory_id ?? memory?.id) : []),
  ];

  return [...new Set(direct.map(toPositiveInt).filter(Boolean))];
}

function enrichCandidateForTruthSelection(candidate = {}, memories = []) {
  const memoryIds = extractCandidateMemoryIds(candidate);
  const fallbackIds = memories
    .map((memory) => toPositiveInt(memory?.memory_id ?? memory?.id ?? memory?.memoryId))
    .filter(Boolean);

  return {
    ...candidate,
    memoryIds: memoryIds.length ? memoryIds : fallbackIds,
  };
}

function hydrateSelectedMemories({ selected = [], memories = [] } = {}) {
  const byId = new Map(
    memories
      .map((memory) => {
        const memoryId = toPositiveInt(memory?.memory_id ?? memory?.id ?? memory?.memoryId);
        return memoryId ? [memoryId, memory] : null;
      })
      .filter(Boolean)
  );

  return selected
    .map((item) => {
      const memoryId = toPositiveInt(item?.memory_id ?? item?.id ?? item?.memoryId);
      const original = memoryId ? byId.get(memoryId) : null;

      return {
        ...(original || {}),
        ...(item || {}),
        memory_id: memoryId || original?.memory_id || null,
        truth_score: item?.truth_score ?? original?.truth_score ?? null,
        truth_decision: item?.truth_decision || item?.status || original?.truth_decision || null,
        truth_reasons: item?.reasons || item?.truth_reasons || [],
      };
    })
    .filter((memory) => memory.memory_id || memory.content || memory.title);
}

export class StoryTruthPipeline {
  constructor({ generateWithAI }) {
    this.generateWithAI = generateWithAI;
  }

  async execute(context) {
    const candidateForSelection = enrichCandidateForTruthSelection(context.candidate, context.memories);

    const rawTruthSelection = selectTruthMemories(context.memories || [], candidateForSelection);
    const truthSelection = buildTruthSelectionReport(rawTruthSelection);

    const selectedMemories = hydrateSelectedMemories({
      selected: truthSelection.selected,
      memories: context.memories || [],
    });

    context.truthSelection = {
      ...truthSelection,
      selected: selectedMemories,
      used_memories: selectedMemories,
    };

    if (!selectedMemories.length) {
      context.addWarning('Truth Memory Selection não encontrou memórias KEEP. Pipeline seguirá sem geração editorial.', {
        statistics: context.truthSelection.statistics,
      });
    }

    if (context.truthSelection.statistics?.optional || context.truthSelection.statistics?.drop) {
      context.addWarning('Truth Prompt aplicado: memórias OPTIONAL e DROP não são autorizadas para geração.', {
        statistics: context.truthSelection.statistics,
        policy: 'KEEP_ONLY_GENERATION',
      });
    }

    const report = await buildStoryTruthUseCase({
      candidate: context.candidate,
      memories: selectedMemories,
      truthSelection: context.truthSelection,
      previousVersions: context.previousVersions,
      generateWithAI: this.generateWithAI,
      language: context.language,
    });

    context.truthReport = {
      ...report,
      truth_selection: context.truthSelection,
      truth_prompt: {
        instruction_version: "GO_LIVE_004_5_TRUTH_PROMPT",
        keep_only: true,
        forbidden_inference: true,
        forbidden_causality_without_evidence: true,
        forbidden_emotions_without_evidence: true,
        forbidden_intentions_without_evidence: true,
        source_policy: "Story Truth Pipeline envia ao Truth Domain apenas memórias KEEP selecionadas e auditáveis.",
      },
    };
    context.validation = report.validation;
    context.evidenceMap = report.evidence_map;
    context.narrativePayload = report.narrative_payload;
    context.manuscript = manuscriptFromTruthReport(report);

    const previousVersion = context.previousVersions?.[0] || null;

    context.lineage = buildStoryLineage({
      storyId: context.storyId,
      versionId: null,
      previousVersionId: previousVersion?.story_version_id || null,
      previousEvidenceMap: previousVersion?.evidence_map || null,
      nextEvidenceMap: context.evidenceMap,
    });

    const policy = AuthorSovereigntyPolicy.validateTruthReport(report);
    context.authorSovereignty = policy;

    if (!policy.approved) {
      context.addWarning('Author Sovereignty Policy exige revisão.', { failures: policy.failures });
    }

    return context;
  }
}
