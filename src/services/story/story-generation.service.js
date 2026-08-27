// C:\HDUD_DATA\hdud-api-node\src\services\story\story-generation.service.js
//
// GO LIVE 008.3 — CHAT 02
// Story Generation Facade -> Generative Editorial Engine
//
// Responsabilidade desta fachada:
// 1. preservar o contrato legado da geração de Histórias;
// 2. aplicar Truth Selection e Truth Validation;
// 3. enviar ao GEE exclusivamente título, pergunta central e textos das memórias KEEP;
// 4. materializar o manuscrito no formato esperado pelas rotas existentes.

import {
  buildStoryTruthPayload,
  buildTruthEvidenceMap,
  validateGeneratedStoryTruth,
} from "./story-truth-engine.service.js";
import {
  materializeStoryStructure,
  mergeMaterializedStory,
} from "./story-materialization-engine.service.js";
import { generateEditorialManuscript } from "../generative/index.js";

const FORBIDDEN_META_TERMS = [
  "blueprint",
  "story blueprint",
  "payload",
  "o autor registra",
  "esta história materializa",
];

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeMemory(memory, index = 0) {
  const memoryId = toPositiveInt(memory?.memory_id ?? memory?.id ?? memory?.memoryId);

  return {
    memory_id: memoryId,
    order_index: toPositiveInt(memory?.narrative_order ?? memory?.sort_order ?? memory?.order_index) || index + 1,
    title: safeText(
      memory?.title || memory?.memory_title,
      memoryId ? `Memória ${memoryId}` : `Memória ${index + 1}`
    ),
    content: safeText(memory?.content || memory?.description || memory?.summary, ""),
    memory_date:
      memory?.memory_date ||
      memory?.narrative_date ||
      memory?.event_date ||
      memory?.created_at ||
      null,
    year: memory?.year || null,
    truth_score: Number(memory?.truth_score ?? memory?.evidence?.truth_score ?? 0) || null,
    truth_decision: memory?.truth_decision ?? memory?.evidence?.decision ?? null,
  };
}

function normalizeStoryCandidate(story = {}) {
  return {
    story_id: toPositiveInt(story?.story_id ?? story?.id ?? story?.candidate_id),
    candidate_id: story?.candidate_id ?? story?.story_id ?? story?.id ?? null,
    title: safeText(
      story?.title || story?.suggested_title || story?.central_theme,
      "História descoberta"
    ),
    central_theme: safeText(
      story?.central_theme ||
        story?.theme ||
        story?.dominant_theme ||
        story?.overview?.central_theme,
      "Continuidade narrativa"
    ),
    summary: safeText(
      story?.summary ||
        story?.one_line_summary ||
        story?.discovery_copy ||
        story?.overview?.why_found,
      ""
    ),
    transformation: safeText(
      story?.main_transformation ||
        story?.transformation ||
        story?.overview?.transformation,
      ""
    ),
    central_question: safeText(
      story?.story_blueprint?.central_question ||
        story?.blueprint?.central_question ||
        story?.central_question ||
        story?.question,
      ""
    ),
    story_blueprint: story?.story_blueprint || story?.blueprint || null,
    confidence: story?.confidence ?? story?.confidence_score ?? null,
    editorial_overview: story?.editorial_overview || story?.overview || null,
    continuity_signals: asArray(story?.continuity_signals),
    truth: story?.truth || null,
  };
}

function sanitizeGeneratedNarrative(value) {
  let text = safeText(value, "");
  if (!text) return "";

  const blockedPatterns = [
    /esta história materializa[^.?!]*(?:[.?!]|$)/gi,
    /esta história foi organizada[^.?!]*(?:[.?!]|$)/gi,
    /a partir do blueprint[^.?!]*(?:[.?!]|$)/gi,
    /story blueprint[^.?!]*(?:[.?!]|$)/gi,
    /na memória \d+[^:]*:/gi,
    /a memória \d+[^.?!]*(?:[.?!]|$)/gi,
    /o autor registra:?/gi,
  ];

  for (const pattern of blockedPatterns) {
    text = text.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  return text;
}

function narrativeLooksMeta(value) {
  const text = safeText(value, "").toLowerCase();
  return FORBIDDEN_META_TERMS.some((term) => text.includes(term));
}

function normalizeTruthSelectionForGeneration(selection = {}, normalizedMemories = []) {
  const byId = new Map(
    asArray(normalizedMemories)
      .filter((memory) => memory?.memory_id)
      .map((memory) => [Number(memory.memory_id), memory])
  );

  function hydrate(items = []) {
    return asArray(items)
      .map((item, index) => {
        const memoryId = toPositiveInt(item?.memory_id ?? item?.id ?? item?.memoryId);
        const base = memoryId ? byId.get(memoryId) : null;

        return normalizeMemory(
          {
            ...(base || {}),
            ...(item || {}),
            memory_id: memoryId || base?.memory_id || null,
            title: item?.title || base?.title,
            content: item?.content || base?.content,
            memory_date: item?.memory_date || base?.memory_date,
            truth_score: item?.truth_score ?? base?.truth_score,
            truth_decision:
              item?.truth_decision || item?.status || base?.truth_decision,
          },
          index
        );
      })
      .filter((memory) => memory.memory_id || memory.title || memory.content);
  }

  const selected = hydrate(selection.selected || selection.used_memories || []);
  const optional = hydrate(selection.optional || selection.optional_memories || []);
  const discarded = hydrate(selection.discarded || selection.discarded_memories || []);

  const statistics = selection.statistics || {
    total: selected.length + optional.length + discarded.length,
    keep: selected.length,
    optional: optional.length,
    drop: discarded.length,
  };

  return {
    ...selection,
    selected,
    optional,
    discarded,
    used_memories: selected,
    optional_memories: optional,
    discarded_memories: discarded,
    statistics,
    truth_report: selection.truth_report || {
      average_truth_score: selected.length
        ? Math.round(
            selected.reduce(
              (sum, memory) => sum + Number(memory.truth_score || 0),
              0
            ) / selected.length
          )
        : 0,
      keep: selected.length,
      optional: optional.length,
      drop: discarded.length,
      source_policy: "Truth Memory Selection aplicado antes do GEE.",
    },
  };
}

function buildGenerativeInput(story, truthMemories) {
  return {
    title: safeText(story?.story_blueprint?.title || story?.title, ""),
    centralQuestion: safeText(
      story?.story_blueprint?.central_question || story?.central_question,
      ""
    ),
    memories: truthMemories
      .map((memory) => safeText(memory?.content, ""))
      .filter(Boolean),
  };
}

function createValidationRejectedError({ story, truthMemories, validation, model }) {
  const error = new Error(
    "A IA não conseguiu produzir um manuscrito fiel às memórias selecionadas. Nenhuma História foi alterada."
  );
  error.statusCode = 422;
  error.code = "STORY_GENERATION_TRUTH_REJECTED";
  error.diagnostics = {
    model,
    validation,
    story_id: story.story_id,
    selected_memory_ids: truthMemories
      .map((memory) => Number(memory.memory_id))
      .filter(Boolean),
  };
  return error;
}

export async function generateStoryEditorialDraft({
  storyCandidate,
  memories = [],
  timeline = [],
  instructions = null,
  truthSelection = null,
  selectedMemoryIds = null,
  selected_memory_ids = null,
  authorId = null,
  userId = null,
} = {}) {
  const story = normalizeStoryCandidate(storyCandidate);
  const requestedIds = new Set(
    asArray(selectedMemoryIds || selected_memory_ids)
      .map(toPositiveInt)
      .filter(Boolean)
  );

  const normalizedMemories = asArray(memories)
    .map(normalizeMemory)
    .sort((a, b) => Number(a.order_index || 0) - Number(b.order_index || 0))
    .filter((memory) => memory.memory_id || memory.title || memory.content)
    .filter(
      (memory) =>
        !requestedIds.size || requestedIds.has(Number(memory.memory_id))
    );

  if (!normalizedMemories.length) {
    const error = new Error(
      "Nenhuma memória válida foi selecionada para gerar o manuscrito."
    );
    error.statusCode = 422;
    error.code = "STORY_MEMORIES_REQUIRED";
    throw error;
  }

  const authorSelectionIsAuthoritative = requestedIds.size > 0;

  if (!authorSelectionIsAuthoritative) {
    const error = new Error(
      "selected_memory_ids é obrigatório para gerar o manuscrito editorial."
    );
    error.statusCode = 422;
    error.code = "STORY_SELECTED_MEMORY_IDS_REQUIRED";
    throw error;
  }

  // GO LIVE 008.4: a seleção do autor é soberana.
  // Truth Selection não escolhe, adiciona ou remove memórias nesta etapa.
  void truthSelection;
  const rawSelection = {
    ok: true,
    selected: normalizedMemories,
    optional: [],
    discarded: [],
    statistics: {
      total: normalizedMemories.length,
      keep: normalizedMemories.length,
      optional: 0,
      drop: 0,
    },
    truth_report: {
      average_truth_score: normalizedMemories.length
        ? Math.round(
            normalizedMemories.reduce(
              (sum, memory) => sum + Number(memory.truth_score || 0),
              0
            ) / normalizedMemories.length
          )
        : 0,
      keep: normalizedMemories.length,
      optional: 0,
      drop: 0,
      source_policy:
        "Seleção editorial explícita do autor aplicada como conjunto KEEP antes do GEE.",
    },
  };

  const selection = normalizeTruthSelectionForGeneration(
    rawSelection,
    normalizedMemories
  );

  const truthMemories = asArray(selection.selected || selection.used_memories)
    .map(normalizeMemory)
    .filter((memory) => memory.memory_id || memory.title || memory.content);

  if (!truthMemories.length) {
    const error = new Error(
      "As memórias selecionadas não produziram evidências autorizadas para a escrita."
    );
    error.statusCode = 422;
    error.code = "STORY_TRUTH_SELECTION_EMPTY";
    throw error;
  }

  const generativeInput = buildGenerativeInput(story, truthMemories);

  if (!generativeInput.memories.length) {
    const error = new Error(
      "As memórias autorizadas não possuem corpo narrativo para geração."
    );
    error.statusCode = 422;
    error.code = "STORY_GENERATIVE_MEMORY_CONTENT_REQUIRED";
    throw error;
  }

  // `instructions` permanece aceito no contrato legado, porém nunca é enviado ao GEE.
  // O GEE recebe exclusivamente título, pergunta central e corpo das memórias KEEP.
  void instructions;

  const generated = await generateEditorialManuscript(generativeInput, {
    usageContext: {
      userId,
      authorId,
      operationCode: "STORY_GENERATION",
      entityType: "STORY",
      entityId: story.story_id,
      metadata: { selected_memory_count: truthMemories.length },
    },
  });
  const narrative = sanitizeGeneratedNarrative(generated.manuscript);

  const validation = narrative
    ? validateGeneratedStoryTruth({
        narrativeContent: narrative,
        usedMemories: truthMemories,
        truthReport: selection.truth_report,
      })
    : {
        decision: "REJECT",
        issues: ["O GEE não retornou conteúdo narrativo."],
        weak_sentences: [],
        hallucination_risk: 100,
        evidence_quality: 0,
      };

  if (!narrative || narrativeLooksMeta(narrative) || validation.decision === "REJECT") {
    throw createValidationRejectedError({
      story,
      truthMemories,
      validation,
      model: generated.model,
    });
  }

  const materializedStructure = materializeStoryStructure({
    story,
    memories: truthMemories,
    timeline,
  });

  const materialized = mergeMaterializedStory({
    generated: {
      title: materializedStructure.title || story.title,
      subtitle:
        materializedStructure.subtitle ||
        story.summary ||
        story.transformation ||
        `História sobre ${story.central_theme.toLowerCase()}.`,
      narrative_content: narrative,
      content: narrative,
    },
    fallback: materializedStructure,
  });

  const evidenceMap = buildTruthEvidenceMap({
    narrativeContent: narrative,
    usedMemories: truthMemories,
    truthReport: selection.truth_report,
  });

  const truthPayload = buildStoryTruthPayload({
    selection,
    evidenceMap,
    validation,
  });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    model: generated.model,
    ai_usage_id: generated.aiUsageId || null,
    provider: generated.provider || null,
    llm_provider: generated.provider || null,
    llm_model: generated.model || null,
    operation_code: generated.operationCode || "STORY_GENERATION",
    generation_provenance: {
      evidence_status: generated.aiUsageId ? "VERIFIED" : "UNVERIFIED",
      evidence_source: generated.aiUsageId ? "AI_USAGE_LEDGER" : null,
      ai_usage_id: generated.aiUsageId || null,
      provider: generated.provider || null,
      model: generated.model || null,
      operation_code: generated.operationCode || "STORY_GENERATION",
      usage_recorded: Boolean(generated.usageRecorded),
    },
    generation_mode: "generative-editorial-engine",
    origin: storyCandidate?.origin || "DISCOVERED_BY_AI",
    story_blueprint: story.story_blueprint || null,
    selected_memory_ids: truthMemories
      .map((memory) => Number(memory.memory_id))
      .filter(Boolean),
    title: materialized.title,
    subtitle: materialized.subtitle,
    lead: materialized.lead,
    progression: materialized.progression,
    climax: materialized.climax,
    closure: materialized.closure,
    legacy: materialized.legacy,
    summary: materialized.summary,
    sections: materialized.sections,
    narrative_content: narrative,
    content: narrative,
    editorial_plan: {
      materialization: materialized,
    },
    source_policy:
      "O manuscrito foi gerado pelo Generative Editorial Engine exclusivamente a partir do corpo das memórias selecionadas pelo autor.",
    generation_notes: [
      "Manuscrito gerado pelo Generative Editorial Engine em modo de preservação da voz autoral.",
      "As memórias são tratadas como texto soberano do Autor; a IA deve atuar principalmente como costura editorial.",
      "Somente título, pergunta central e corpo das memórias selecionadas pelo autor foram enviados à IA.",
      "Blueprint, Truth Report, scores, timeline, taxonomia, grafo, diagnósticos e metadata interna não foram enviados à IA.",
    ],
    truth: truthPayload,
    truth_selection: {
      selected: selection.selected,
      optional: selection.optional,
      discarded: selection.discarded,
      statistics: selection.statistics,
    },
    truth_prompt: {
      policy: "GEE_INTERNAL_PROMPT_POLICY",
      instruction_version: "GO_LIVE_008_5_AUTHOR_VOICE_PRESERVATION",
      keep_only: true,
      forbidden_inference: true,
      forbidden_causality_without_evidence: true,
      forbidden_emotions_without_evidence: true,
      forbidden_intentions_without_evidence: true,
    },
    evidence_map: evidenceMap,
    story_evidence_score: truthPayload.story_evidence_score,
    usage: {
      prompt_tokens: generated.promptTokens,
      completion_tokens: generated.completionTokens,
      total_tokens: generated.totalTokens,
    },
    diagnostics: {
      openai_failed: false,
      openai_error: null,
      generation_mode: "generative-editorial-engine",
      selection_mode: "author-editorial-selection",
      author_selection_authoritative: authorSelectionIsAuthoritative,
      generation_attempt: 1,
      memory_count: normalizedMemories.length,
      narrative_order_applied: truthMemories.map((memory) => ({ memory_id: memory.memory_id, order: memory.order_index })),
      used_memory_count: truthMemories.length,
      discarded_memory_count: asArray(selection.discarded_memories).length,
      story_id: story.story_id,
      truth_validation_decision: validation.decision,
      hallucination_risk: validation.hallucination_risk,
      evidence_quality: validation.evidence_quality,
      blueprint_used_by_facade: Boolean(story.story_blueprint),
      blueprint_sent_to_gee: false,
      timeline_sent_to_gee: false,
      metadata_sent_to_gee: false,
      prompt_tokens: generated.promptTokens,
      completion_tokens: generated.completionTokens,
      total_tokens: generated.totalTokens,
      ai_usage_id: generated.aiUsageId || null,
      provider: generated.provider || null,
      operation_code: generated.operationCode || "STORY_GENERATION",
      provenance_evidence_status: generated.aiUsageId ? "VERIFIED" : "UNVERIFIED",
    },
  };
}
