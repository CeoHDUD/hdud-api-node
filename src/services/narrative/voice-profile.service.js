// C:\HDUD_DATA\hdud-api-node\src\services\narrative\voice-profile.service.js

import OpenAI from "openai";

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

export async function generateVoiceProfile({
  authorId,
  memories = [],
}) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  if (!memories.length) {
    return {
      ok: false,
      reason: "Nenhuma memória disponível.",
    };
  }

  const client = new OpenAI();

  const payload = {
    author_id: Number(authorId),

    memories: memories.map((m) => ({
      memory_id: Number(m.memory_id),
      title: m.title || null,
      content: m.content || "",
      phase_code: m.phase_code || null,
    })),
  };

  const response =
    await client.responses.create({
      model: DEFAULT_MODEL,

      instructions: `
Você é o HDUD Voice Profile Engine.

MISSÃO:
Analisar memórias reais de um autor
e identificar sua assinatura narrativa.

OBJETIVOS:
- entender estilo de escrita
- intensidade emocional
- ritmo narrativo
- densidade textual
- tom autobiográfico
- perfil emocional

REGRAS ABSOLUTAS:
- NÃO invente fatos
- NÃO invente personalidade
- NÃO criar diagnóstico psicológico
- NÃO extrapolar além do texto

RESPONDA EXCLUSIVAMENTE EM JSON:

{
  "writing_style": "",
  "emotional_tone": "",
  "narrative_density": 0,
  "sentence_length_avg": 0,
  "emotional_intensity": 0,
  "preferred_language": "",
  "ai_observations": []
}
`,
      input: JSON.stringify(payload),
    });

  const text = response.output_text || "";

  const parsed = safeJsonParse(text);

  if (!parsed?.writing_style) {
    return {
      ok: false,
      reason:
        "IA não retornou perfil válido.",
      raw: text,
    };
  }

  return {
    ok: true,
    model: DEFAULT_MODEL,
    profile: parsed,
  };
}