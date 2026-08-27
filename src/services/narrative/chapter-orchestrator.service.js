// C:\HDUD_DATA\hdud-api-node\src\services\narrative\chapter-orchestrator.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";

const DEFAULT_MODEL =
  process.env.OPENAI_NARRATIVE_MODEL ||
  "gpt-4.1";

function hasOpenAIKey() {
  return Boolean(
    String(
      process.env.OPENAI_API_KEY || ""
    ).trim()
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeMemory(memory) {
  return {
    memory_id:
      Number(memory.memory_id),

    title:
      memory.title || null,

    content:
      memory.content || "",

    created_at:
      memory.created_at || null,

    published_at:
      memory.published_at || null,

    phase_code:
      memory.phase_code || null,

    emotional_weight:
      Number(
        memory.emotional_weight || 0
      ),

    narrative_importance:
      Number(
        memory.narrative_importance || 0
      ),

    arc_code:
      memory.arc_code || null,

    cluster_code:
      memory.cluster_code || null,
  };
}

export async function orchestrateNarrativeChapter({
  author,
  memories = [],
  voiceProfile = null,
  arcs = [],
  emotionalClusters = [],
}) {

  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason:
        "OPENAI_API_KEY ausente.",
    };
  }

  if (
    !Array.isArray(memories) ||
    memories.length === 0
  ) {
    return {
      ok: false,
      reason:
        "Nenhuma memória enviada.",
    };
  }

  const client =
    new OpenAI();

  const normalizedMemories =
    memories.map(
      normalizeMemory
    );

  const payload = {

    author: {
      author_id:
        Number(
          author?.author_id
        ),

      author_name:
        author?.name_public ||
        null,
    },

    voice_profile:
      voiceProfile || null,

    arcs:
      Array.isArray(arcs)
        ? arcs
        : [],

    emotional_clusters:
      Array.isArray(
        emotionalClusters
      )
        ? emotionalClusters
        : [],

    memories:
      normalizedMemories,
  };

  await assertExternalAIAllowed({ authorId: author?.author_id });
  const response =
    await client.responses.create({

      model:
        DEFAULT_MODEL,

      instructions: `
Você é o HDUD Chapter Orchestrator Engine.

MISSÃO:
Transformar memórias humanas reais em um capítulo autobiográfico editorialmente estruturado.

OBJETIVOS:
- preservar voz autoral
- preservar continuidade emocional
- preservar cronologia narrativa
- detectar progressão emocional
- construir capítulo coeso
- respeitar trajetória humana

REGRAS ABSOLUTAS:
- NÃO inventar fatos
- NÃO criar eventos inexistentes
- NÃO alterar significado emocional
- NÃO criar psicologia artificial
- NÃO criar trauma inexistente
- NÃO romantizar sofrimento
- NÃO transformar em ficção

ESTRUTURA:
- abertura emocional
- progressão narrativa
- ponto de transformação
- fechamento narrativo

ESTILO:
- autobiográfico
- humano
- editorial premium
- emocionalmente coerente
- cinematicamente fluido
- preservando autenticidade

RESPONDA EXCLUSIVAMENTE EM JSON:

{
  "chapter": {
    "title": "",
    "summary": "",
    "opening_memory_id": 0,
    "closing_memory_id": 0,
    "dominant_arc": "",
    "dominant_cluster": "",
    "emotional_journey": "",
    "chapter_content": ""
  }
}
`,

      input:
        JSON.stringify(payload),
    });

  await recordExternalAIUsage({
    authorId: author?.author_id, operationCode: "NARRATIVE_CHAPTER_ORCHESTRATION",
    model: response?.model || DEFAULT_MODEL, ...extractOpenAIUsage(response),
    entityType: "CHAPTER_DRAFT", metadata: { source_memory_count: normalizedMemories.length },
  });

  const text =
    response.output_text || "";

  const parsed =
    safeJsonParse(text);

  if (
    !parsed?.chapter
  ) {
    return {
      ok: false,
      reason:
        "IA não retornou capítulo válido.",
      raw: text,
    };
  }

  return {
    ok: true,

    engine:
      "HDUD Chapter Orchestrator Engine v1",

    model:
      DEFAULT_MODEL,

    chapter:
      parsed.chapter,

    meta: {
      generated_at:
        new Date().toISOString(),

      source_policy:
        "Somente memórias reais persistidas no Living Narrative Graph.",

      orchestration_mode:
        "AUTOBIOGRAPHICAL_EDITORIAL_INTELLIGENCE",
    },
  };
}