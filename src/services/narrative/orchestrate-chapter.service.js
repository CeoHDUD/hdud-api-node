// C:\HDUD_DATA\hdud-api-node\src\services\narrative\chapter-orchestrator.service.js

import OpenAI from "openai";
import { loadAuthorNarrativeContext } from "./narrative-orchestrator.service.js";
import { buildAutobiographicalCognition } from "./autobiographical-cognition.service.js";
import { recallConnectedMemories } from "./memory-recall.service.js";

const DEFAULT_MODEL =
  process.env.OPENAI_NARRATIVE_MODEL || "gpt-4.1";

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeMemoryIds(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
    ),
  ].slice(0, 50);
}

export async function orchestrateNarrativeChapter({
  authorId,
  memoryIds = [],
  options = {},
}) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  const ids = normalizeMemoryIds(memoryIds);

  if (!ids.length) {
    return {
      ok: false,
      reason: "memoryIds obrigatório.",
    };
  }

  const context = await loadAuthorNarrativeContext({
    authorId,
    memoryIds: ids,
  });

  if (!context?.ok) {
    return {
      ok: false,
      reason: context?.reason || "Falha ao carregar contexto narrativo.",
    };
  }

  const cognition = await buildAutobiographicalCognition({
    authorId,
  });

  const recalls = [];

  for (const memoryId of ids.slice(0, 10)) {
    const recall = await recallConnectedMemories({
      authorId,
      memoryId,
      limit: 5,
    });

    if (recall?.ok) {
      recalls.push(recall);
    }
  }

  const client = new OpenAI();

  const payload = {
    author: context.author,
    memories: context.memories,
    voice_profile: context.voice_profile,
    cognition: cognition?.cognition || null,
    emotional_clusters: context.emotional_clusters?.clusters || [],
    narrative_arcs: context.narrative_arcs?.arcs || [],
    relationship_evolution:
      context.relationship_evolution?.relationships || [],
    memory_recalls: recalls,
    graph: context.graph,
    options,
  };

  const response = await client.responses.create({
    model: DEFAULT_MODEL,
    instructions: `
Você é o HDUD Chapter Orchestrator Engine v2.

MISSÃO:
Gerar um capítulo autobiográfico editorialmente estruturado usando memórias reais, contexto cognitivo e Living Narrative Graph.

REGRAS ABSOLUTAS:
- NÃO invente fatos.
- NÃO crie memórias inexistentes.
- NÃO altere o significado emocional original.
- NÃO adicione personagens, eventos ou relações não presentes no contexto.
- NÃO romantize sofrimento.
- NÃO transforme em ficção.
- Preserve a voz autoral.
- Use apenas dados reais fornecidos no payload.

USE COMO CONTEXTO:
- memórias selecionadas
- voice profile
- autobiographical cognition
- emotional clusters
- narrative arcs
- relationship evolution
- memory recall
- graph entities
- graph relationships
- timeline

OBJETIVO EDITORIAL:
- abertura forte
- progressão emocional
- continuidade autobiográfica
- callbacks narrativos quando existirem
- fechamento com sentido humano
- texto fluido, premium e fiel ao autor

RESPONDA EXCLUSIVAMENTE EM JSON:

{
  "chapter": {
    "title": "",
    "subtitle": "",
    "summary": "",
    "dominant_arc": "",
    "dominant_cluster": "",
    "emotional_journey": "",
    "opening_memory_id": 0,
    "closing_memory_id": 0,
    "source_memory_ids": [],
    "editorial_notes": [],
    "chapter_content": ""
  }
}
`,
    input: JSON.stringify(payload),
  });

  const text = response.output_text || "";
  const parsed = safeJsonParse(text);

  if (!parsed?.chapter) {
    return {
      ok: false,
      reason: "IA não retornou capítulo válido.",
      raw: text,
    };
  }

  return {
    ok: true,
    engine: "HDUD Chapter Orchestrator Engine v2",
    mode: "openai_live",
    model: DEFAULT_MODEL,
    author_id: Number(authorId),
    chapter: parsed.chapter,
    context_summary: {
      memories: context.memories.length,
      entities: context.graph?.entities?.length || 0,
      relationships: context.graph?.relationships?.length || 0,
      timeline_events: context.graph?.timeline?.length || 0,
      recalls: recalls.length,
      voice_profile_loaded: Boolean(context.voice_profile?.loaded),
    },
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Somente memórias e dados reais persistidos no Living Narrative Graph.",
      orchestration_layer:
        "AUTOBIOGRAPHICAL_EDITORIAL_SYNTHESIS",
    },
  };
}