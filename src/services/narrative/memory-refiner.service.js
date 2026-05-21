// C:\HDUD_DATA\hdud-api-node\src\services\narrative\memory-refiner.service.js

import OpenAI from "openai";

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

function normalizeVoiceProfile(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    writing_style: value.writing_style || null,
    emotional_tone: value.emotional_tone || null,
    narrative_density: value.narrative_density ?? null,
    sentence_length_avg: value.sentence_length_avg ?? null,
    emotional_intensity: value.emotional_intensity ?? null,
    preferred_language: value.preferred_language || null,
    ai_observations: Array.isArray(value.ai_observations)
      ? value.ai_observations
      : [],
  };
}

export async function refineMemoryWithOpenAI({
  memory,
  options = {},
  voiceProfile = null,
}) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  const client = new OpenAI();

  const normalizedVoiceProfile = normalizeVoiceProfile(voiceProfile);

  const payload = {
    memory: {
      memory_id: Number(memory.memory_id),
      title: memory.title || null,
      content: memory.content || "",
      phase_code: memory.phase_code || null,
    },

    options: {
      mode: options.mode || "editorial",
      preserve_voice: options.preserve_voice !== false,
      intensity: Number(options.intensity || 7),
      language:
        options.language ||
        normalizedVoiceProfile?.preferred_language ||
        "pt-BR",
    },

    voice_profile: normalizedVoiceProfile,
  };

  const response = await client.responses.create({
    model: DEFAULT_MODEL,

    instructions: `
Você é o HDUD Memory Refiner Engine v2.

MISSÃO:
Refinar uma memória humana real usando a assinatura narrativa do autor.

CONTEXTO:
A memória fornecida é real.
O perfil de voz, quando existir, representa padrões narrativos observados nas memórias reais do autor.

OBJETIVOS:
- corrigir gramática
- melhorar fluidez
- preservar voz do autor
- preservar emoção original
- respeitar o perfil narrativo do autor
- manter naturalidade humana
- amplificar o autor, sem substituí-lo

USO DO VOICE PROFILE:
Quando voice_profile existir:
- respeite writing_style
- respeite emotional_tone
- respeite narrative_density
- respeite emotional_intensity
- respeite preferred_language
- use ai_observations apenas como orientação estilística
- NÃO trate o perfil como diagnóstico psicológico
- NÃO invente traços pessoais além do texto

REGRAS ABSOLUTAS:
- NÃO invente fatos
- NÃO altere acontecimentos
- NÃO mude nomes
- NÃO adicione personagens
- NÃO adicione datas não informadas
- NÃO transforme em texto artificial
- NÃO destrua o estilo do autor
- NÃO exagere emoção além da intensidade solicitada
- preserve o sentido original da memória

RESPONDA EXCLUSIVAMENTE EM JSON VÁLIDO:

{
  "refined_title": "...",
  "refined_content": "...",
  "voice_preserved": true,
  "voice_profile_used": true,
  "emotional_intensity": 0,
  "changes_summary": [],
  "source_policy": "Somente memória real do autor. Sem conteúdo inventado."
}
`,
    input: JSON.stringify(payload),
  });

  const text = response.output_text || "";
  const parsed = safeJsonParse(text);

  if (!parsed?.refined_content) {
    return {
      ok: false,
      reason: "IA não retornou JSON válido.",
      raw: text,
    };
  }

  return {
    ok: true,
    model: DEFAULT_MODEL,
    result: {
      refined_title: parsed.refined_title || memory.title || null,
      refined_content: parsed.refined_content,
      voice_preserved: parsed.voice_preserved !== false,
      voice_profile_used: Boolean(normalizedVoiceProfile),
      emotional_intensity:
        Number.isFinite(Number(parsed.emotional_intensity))
          ? Number(parsed.emotional_intensity)
          : Number(options.intensity || 7),
      changes_summary: Array.isArray(parsed.changes_summary)
        ? parsed.changes_summary
        : [],
      source_policy:
        parsed.source_policy ||
        "Somente memória real do autor. Sem conteúdo inventado.",
    },
  };
}