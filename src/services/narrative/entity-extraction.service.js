// C:\HDUD_DATA\hdud-api-node\src\services\narrative\entity-extraction.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";

const DEFAULT_MODEL = process.env.OPENAI_NARRATIVE_MODEL || "gpt-4.1";

const SELF_AUTHOR_ENTITY = {
  entity_type: "SELF",
  entity_name: "SELF_AUTHOR",
  relationship_type: "AUTHOR",
  emotional_weight: 10,
  emotional_relevance: 10,
  summary: "Entidade canônica que representa o próprio autor/narrador da memória.",
};

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

function safeJsonParse(text) {
  const clean = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text.length ? text : fallback;
}

function normalizeEntityName(value) {
  const name = normalizeText(value, "");
  if (!name) return "";

  const key = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

  const selfAliases = new Set([
    "EU",
    "MIM",
    "ME",
    "COMIGO",
    "NARRADOR",
    "NARRADORA",
    "AUTOR",
    "AUTORA",
    "O NARRADOR",
    "A NARRADORA",
    "O AUTOR",
    "A AUTORA",
    "O PROPRIO AUTOR",
    "A PROPRIA AUTORA",
    "PROPRIO AUTOR",
    "PROPRIA AUTORA",
    "SELF",
    "SELF_AUTHOR",
  ]);

  if (selfAliases.has(key)) return "SELF_AUTHOR";

  return name;
}

function clampInt(value, min = 0, max = 10, fallback = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeEntity(entity) {
  const entityName = normalizeEntityName(entity?.entity_name);
  if (!entityName) return null;

  const entityType =
    entityName === "SELF_AUTHOR"
      ? "SELF"
      : normalizeText(entity?.entity_type, "UNKNOWN").toUpperCase();

  return {
    entity_type: entityType,
    entity_name: entityName,
    relationship_type:
      entityName === "SELF_AUTHOR"
        ? "AUTHOR"
        : normalizeText(entity?.relationship_type, null),
    emotional_weight: clampInt(entity?.emotional_weight, 0, 10, 5),
    emotional_relevance: clampInt(entity?.emotional_relevance, 0, 10, 5),
    summary: normalizeText(entity?.summary, null),
  };
}

function ensureSelfAuthorEntity(entities) {
  const hasSelf = entities.some((entity) => entity.entity_name === "SELF_AUTHOR");

  if (hasSelf) return entities;

  return [SELF_AUTHOR_ENTITY, ...entities];
}

export async function extractNarrativeEntities({ memory }) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  const client = new OpenAI();

  const payload = {
    memory: {
      memory_id: Number(memory.memory_id),
      title: memory.title || null,
      content: memory.content || "",
      phase_code: memory.phase_code || null,
    },
  };

  await assertExternalAIAllowed({ authorId: memory?.author_id });
  const response = await client.responses.create({
    model: DEFAULT_MODEL,
    instructions: `
Você é o HDUD Entity Extraction Engine.

MISSÃO:
Extrair entidades narrativas reais de memórias humanas.

REGRA CANÔNICA OBRIGATÓRIA:
- Toda memória pertence a um autor.
- O próprio autor/narrador deve ser representado sempre como:
  entity_type: "SELF"
  entity_name: "SELF_AUTHOR"
  relationship_type: "AUTHOR"
- Se o texto usar "eu", "me", "mim", "comigo", "autor", "narrador" ou equivalentes, normalize para SELF_AUTHOR.
- Nunca use o nome pessoal do autor se o texto estiver falando do próprio narrador em primeira pessoa.

OBJETIVOS:
- identificar pessoas
- identificar lugares
- identificar eventos
- identificar relações explícitas
- identificar emoções relevantes
- preservar somente entidades reais detectadas ou estruturalmente canônicas

REGRAS ABSOLUTAS:
- NÃO invente entidades
- NÃO inferir além do texto
- NÃO criar fatos inexistentes
- NÃO criar psicologia artificial
- NÃO criar personagens externos
- NÃO duplicar SELF_AUTHOR com "eu", "autor" ou "narrador"

TIPOS ACEITOS:
- SELF
- PERSON
- PLACE
- EVENT
- RELATIONSHIP
- EMOTION

RESPONDA EXCLUSIVAMENTE EM JSON:

{
  "entities": [
    {
      "entity_type": "",
      "entity_name": "",
      "relationship_type": "",
      "emotional_weight": 0,
      "emotional_relevance": 0,
      "summary": ""
    }
  ]
}
`,
    input: JSON.stringify(payload),
  });

  await recordExternalAIUsage({
    authorId: memory?.author_id, operationCode: "NARRATIVE_ENTITY_EXTRACTION",
    model: response?.model || DEFAULT_MODEL, ...extractOpenAIUsage(response),
    entityType: "MEMORY", entityId: memory?.memory_id,
  });

  const text = response.output_text || "";
  const parsed = safeJsonParse(text);

  if (!parsed?.entities) {
    return {
      ok: false,
      reason: "IA não retornou entidades válidas.",
      raw: text,
    };
  }

  const normalizedEntities = Array.isArray(parsed.entities)
    ? parsed.entities.map(normalizeEntity).filter(Boolean)
    : [];

  return {
    ok: true,
    model: DEFAULT_MODEL,
    entities: ensureSelfAuthorEntity(normalizedEntities),
  };
}