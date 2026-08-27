// C:\HDUD_DATA\hdud-api-node\src\services\narrative\openai-narrative.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";

const DEFAULT_MODEL = process.env.OPENAI_NARRATIVE_MODEL || "gpt-4.1";

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

export async function generateNarrativeChapterWithOpenAI({ memories, options = {} }) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  const client = new OpenAI();

  const payload = {
    tone: options?.tone || "autobiografico",
    style: options?.style || "editorial",
    intensity: options?.intensity || 7,
    preserve_voice: options?.preserve_voice !== false,
    memories: memories.map((m, index) => ({
      order: index + 1,
      memory_id: Number(m.memory_id),
      title: m.title || null,
      content: m.content || "",
      phase_code: m.phase_code || null,
      created_at: m.created_at || null,
      published_at: m.published_at || null,
    })),
  };

  await assertExternalAIAllowed({ authorId: options?.authorId || memories?.[0]?.author_id });
  const response = await client.responses.create({
    model: DEFAULT_MODEL,
    instructions: `
Você é o HDUD AI Narrative Engine.

MISSÃO:
Transformar memórias reais em um capítulo editorial autobiográfico.

REGRAS ABSOLUTAS:
- Não invente fatos.
- Não adicione eventos que não estejam nas memórias.
- Preserve a voz do autor.
- Amplifique a narrativa, não substitua o autor.
- Use somente as memórias fornecidas.
- Responda exclusivamente em JSON válido.

FORMATO:
{
  "chapter_title": "...",
  "chapter_content": "...",
  "emotional_arc": "...",
  "characters": [],
  "timeline": [],
  "source_policy": "Somente memórias reais do autor. Sem conteúdo inventado."
}
`,
    input: JSON.stringify(payload),
  });

  await recordExternalAIUsage({
    authorId: options?.authorId || memories?.[0]?.author_id,
    operationCode: "NARRATIVE_CHAPTER_GENERATION", model: response?.model || DEFAULT_MODEL,
    ...extractOpenAIUsage(response), entityType: "CHAPTER_DRAFT",
    metadata: { source_memory_count: memories.length },
  });

  const text = response.output_text || "";
  const parsed = safeJsonParse(text);

  if (!parsed?.chapter_content) {
    return {
      ok: false,
      reason: "Resposta da IA não retornou JSON válido.",
      raw: text,
    };
  }

  return {
    ok: true,
    model: DEFAULT_MODEL,
    chapter: parsed,
  };
}