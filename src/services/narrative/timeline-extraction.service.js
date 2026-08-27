// C:\HDUD_DATA\hdud-api-node\src\services\narrative\timeline-extraction.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";

const DEFAULT_MODEL =
  process.env.OPENAI_NARRATIVE_MODEL || "gpt-4.1";

function hasOpenAIKey() {
  return Boolean(
    String(process.env.OPENAI_API_KEY || "").trim()
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function extractTimelineEvents({
  memory,
}) {
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
      memory_date: memory.memory_date || null,
      created_at: memory.created_at || null,
    },
  };

  await assertExternalAIAllowed({ authorId: memory?.author_id });
  const response =
    await client.responses.create({
      model: DEFAULT_MODEL,

      instructions: `
Você é o HDUD Timeline Extraction Engine.

MISSÃO:
Transformar memórias humanas reais em eventos estruturados da linha da vida.

OBJETIVOS:
- detectar marcos narrativos
- detectar eventos emocionalmente relevantes
- identificar progressão temporal
- estruturar timeline humana

REGRAS ABSOLUTAS:
- NÃO invente fatos
- NÃO inferir além do texto
- NÃO criar datas inexistentes
- NÃO criar acontecimentos fictícios

TIPOS ACEITOS:
- RELATIONSHIP
- FAMILY
- CAREER
- LOSS
- REBIRTH
- CHANGE
- ACHIEVEMENT
- HEALTH
- LIFE_EVENT

RESPONDA EXCLUSIVAMENTE EM JSON:

{
  "timeline_events": [
    {
      "timeline_type": "",
      "title": "",
      "description": "",
      "event_date": null,
      "emotional_weight": 0,
      "narrative_importance": 0
    }
  ]
}
`,
      input: JSON.stringify(payload),
    });

  await recordExternalAIUsage({
    authorId: memory?.author_id, operationCode: "NARRATIVE_TIMELINE_EXTRACTION",
    model: response?.model || DEFAULT_MODEL, ...extractOpenAIUsage(response),
    entityType: "MEMORY", entityId: memory?.memory_id,
  });

  const text = response.output_text || "";

  const parsed = safeJsonParse(text);

  if (!parsed?.timeline_events) {
    return {
      ok: false,
      reason:
        "IA não retornou timeline válida.",
      raw: text,
    };
  }

  return {
    ok: true,
    model: DEFAULT_MODEL,
    timeline_events: Array.isArray(
      parsed.timeline_events
    )
      ? parsed.timeline_events
      : [],
  };
}