// C:\HDUD_DATA\hdud-api-node\src\services\narrative\relationship-extraction.service.js

import OpenAI from "openai";

const DEFAULT_MODEL = process.env.OPENAI_NARRATIVE_MODEL || "gpt-4.1";

const ACCEPTED_RELATIONSHIP_TYPES = new Set([
  "SPOUSE",
  "PARTNER",
  "PARENT",
  "CHILD",
  "FAMILY",
  "FRIEND",
  "PLACE_ASSOCIATION",
  "EVENT_ASSOCIATION",
  "EMOTIONAL_ASSOCIATION",
  "LIFE_MARKER",
  "SELF_CONTEXT",
]);

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

function normalizeRelationshipType(value) {
  const type = normalizeText(value, "").toUpperCase();
  return ACCEPTED_RELATIONSHIP_TYPES.has(type) ? type : null;
}

function buildEntityNameSet(entities) {
  return new Set(
    entities
      .map((entity) => normalizeEntityName(entity.entity_name))
      .filter(Boolean)
  );
}

function normalizeRelationship(rel, entityNames) {
  const sourceName = normalizeEntityName(rel?.source_entity_name);
  const targetName = normalizeEntityName(rel?.target_entity_name);
  const relationshipType = normalizeRelationshipType(rel?.relationship_type);

  if (!sourceName || !targetName || !relationshipType) return null;
  if (sourceName === targetName) return null;

  if (!entityNames.has(sourceName) || !entityNames.has(targetName)) {
    return null;
  }

  return {
    source_entity_name: sourceName,
    target_entity_name: targetName,
    relationship_type: relationshipType,
    emotional_strength: clampInt(rel?.emotional_strength, 0, 10, 5),
    narrative_weight: clampInt(rel?.narrative_weight, 0, 10, 5),
    summary: normalizeText(rel?.summary, null),
  };
}

export async function extractNarrativeRelationships({ memory, entities = [] }) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  const normalizedEntities = entities
    .map((entity) => ({
      entity_id: Number(entity.entity_id),
      entity_type: entity.entity_type || null,
      entity_name: normalizeEntityName(entity.entity_name),
    }))
    .filter((entity) => entity.entity_id && entity.entity_name);

  const entityNames = buildEntityNameSet(normalizedEntities);

  if (normalizedEntities.length < 2) {
    return {
      ok: true,
      model: DEFAULT_MODEL,
      relationships: [],
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
    entities: normalizedEntities,
  };

  const response = await client.responses.create({
    model: DEFAULT_MODEL,
    instructions: `
Você é o HDUD Relationship Extraction Engine.

MISSÃO:
Detectar relações narrativas reais entre entidades extraídas de uma memória humana.

REGRA CANÔNICA OBRIGATÓRIA:
- SELF_AUTHOR representa o próprio autor/narrador.
- Se a relação envolve "eu", "me", "mim", "comigo", "autor" ou "narrador", use exatamente SELF_AUTHOR.
- Use exatamente os nomes de entity_name recebidos no payload.
- Nunca crie entidade nova dentro da relação.
- Nunca invente relação entre entidades apenas porque ambas aparecem no texto.

OBJETIVOS:
- identificar relações entre pessoas, lugares e eventos
- detectar vínculo narrativo entre entidades já existentes
- atribuir força emocional
- atribuir peso narrativo
- preservar vínculo cross-memory para uso futuro no grafo narrativo

REGRAS ABSOLUTAS:
- NÃO invente relações
- NÃO crie relação se ela não estiver clara no texto
- NÃO inferir parentesco sem evidência
- NÃO criar psicologia artificial
- NÃO criar fatos inexistentes
- NÃO usar entidade fora da lista recebida
- NÃO duplicar SELF_AUTHOR como "eu", "autor" ou "narrador"

TIPOS ACEITOS:
- SPOUSE
- PARTNER
- PARENT
- CHILD
- FAMILY
- FRIEND
- PLACE_ASSOCIATION
- EVENT_ASSOCIATION
- EMOTIONAL_ASSOCIATION
- LIFE_MARKER
- SELF_CONTEXT

RESPONDA EXCLUSIVAMENTE EM JSON:

{
  "relationships": [
    {
      "source_entity_name": "",
      "target_entity_name": "",
      "relationship_type": "",
      "emotional_strength": 0,
      "narrative_weight": 0,
      "summary": ""
    }
  ]
}
`,
    input: JSON.stringify(payload),
  });

  const text = response.output_text || "";
  const parsed = safeJsonParse(text);

  if (!parsed?.relationships) {
    return {
      ok: false,
      reason: "IA não retornou relações válidas.",
      raw: text,
    };
  }

  const relationships = Array.isArray(parsed.relationships)
    ? parsed.relationships
        .map((rel) => normalizeRelationship(rel, entityNames))
        .filter(Boolean)
    : [];

  return {
    ok: true,
    model: DEFAULT_MODEL,
    relationships,
  };
}