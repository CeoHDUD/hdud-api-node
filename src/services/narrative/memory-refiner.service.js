// C:\HDUD_DATA\hdud-api-node\src\services\narrative\memory-refiner.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";
import { resolveNarrativeContextForMemory } from "../memory-editorial-intelligence.service.js";

const DEFAULT_MODEL = process.env.OPENAI_NARRATIVE_MODEL || "gpt-4.1";
export const MEMORY_REFINER_PROMPT_VERSION = "memory-editorial-v1";

const MAX_CHARS_SINGLE_PASS = 4200;
const MIN_PRESERVATION_RATIO = 0.9;
const MAX_RETRIES = 2;

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

function stripJsonFence(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function safeJsonParse(text) {
  const clean = stripJsonFence(text);

  try {
    return JSON.parse(clean);
  } catch {
    const first = clean.indexOf("{");
    const last = clean.lastIndexOf("}");

    if (first >= 0 && last > first) {
      try {
        return JSON.parse(clean.slice(first, last + 1));
      } catch {
        return null;
      }
    }

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


function normalizeNarrativeContext(value) {
  if (!value || typeof value !== "object") return null;

  const lifePeriodCode = String(
    value.life_period?.code || value.life_period_code || value.life_period || ""
  ).trim().toUpperCase();
  const contextCode = String(
    value.editorial_context?.code || value.context_code || value.editorial_context || ""
  ).trim().toUpperCase();
  const roleCode = String(
    value.narrative_role?.code || value.narrative_role_code || value.narrative_role || ""
  ).trim().toUpperCase();

  if (!lifePeriodCode || !contextCode || !roleCode) return null;

  return {
    life_period: {
      code: lifePeriodCode,
      label: value.life_period?.label || lifePeriodCode,
    },
    editorial_context: {
      code: contextCode,
      label: value.editorial_context?.label || contextCode,
    },
    narrative_role: {
      code: roleCode,
      label: value.narrative_role?.label || roleCode,
    },
    narrative_path:
      value.narrative_path || `${lifePeriodCode} > ${contextCode} > ${roleCode}`,
    graph_path: value.graph_path || null,
    valid: value.valid === true,
    legacy_path: value.legacy_path === true,
    validation_reason: value.validation_reason || value.reason || null,
    classification_source: value.classification_source || "AUTHOR",
    classification_version: value.classification_version || null,
    author_sovereignty: true,
    immutable_for_ai: true,
  };
}

async function resolveRefinementNarrativeContext(memory, providedContext) {
  const normalizedProvided = normalizeNarrativeContext(providedContext);
  if (normalizedProvided) return normalizedProvided;

  const embedded = normalizeNarrativeContext({
    life_period_code: memory?.life_period_code || memory?.life_period,
    context_code: memory?.context_code || memory?.editorial_context,
    narrative_role_code: memory?.narrative_role_code || memory?.narrative_role,
    narrative_path: memory?.narrative_path,
  });
  if (embedded) return embedded;

  const memoryId = Number(memory?.memory_id);
  const authorId = Number(memory?.author_id);
  if (!Number.isInteger(memoryId) || memoryId <= 0) return null;

  const resolved = await resolveNarrativeContextForMemory({
    memoryId,
    authorId: Number.isInteger(authorId) && authorId > 0 ? authorId : null,
    requireValidPath: false,
  });

  return normalizeNarrativeContext(resolved?.narrative_context);
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function getCharStats(originalContent, refinedContent) {
  const original_chars = normalizeText(originalContent).length;
  const refined_chars = normalizeText(refinedContent).length;

  return {
    original_chars,
    refined_chars,
    preservation_ratio:
      original_chars > 0 ? Number((refined_chars / original_chars).toFixed(4)) : 1,
    min_required_ratio: MIN_PRESERVATION_RATIO,
  };
}

function validateContentPreservation(originalContent, refinedContent) {
  const stats = getCharStats(originalContent, refinedContent);

  if (stats.original_chars >= 500 && stats.preservation_ratio < MIN_PRESERVATION_RATIO) {
    return {
      ok: false,
      reason: "EDITORIAL_CONTENT_LOSS_DETECTED",
      stats,
    };
  }

  return {
    ok: true,
    stats,
  };
}

function splitMemoryIntoEditorialChunks(content, maxChars = MAX_CHARS_SINGLE_PASS) {
  const text = normalizeText(content);
  if (!text) return [""];

  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const block = paragraph.trim();
    if (!block) continue;

    if (block.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }

      const sentences = block.match(/[^.!?。！？]+[.!?。！？]*|\S+/g) || [block];
      let sentenceChunk = "";

      for (const sentence of sentences) {
        const next = sentenceChunk ? `${sentenceChunk} ${sentence}` : sentence;

        if (next.length > maxChars && sentenceChunk.trim()) {
          chunks.push(sentenceChunk.trim());
          sentenceChunk = sentence;
        } else {
          sentenceChunk = next;
        }
      }

      if (sentenceChunk.trim()) {
        chunks.push(sentenceChunk.trim());
      }

      continue;
    }

    const next = current ? `${current}\n\n${block}` : block;

    if (next.length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = block;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length ? chunks : [text];
}

function buildInstructions({ isChunk = false, retryAttempt = 0, narrativeContext = null } = {}) {
  const strictness =
    retryAttempt > 0
      ? `
ATENÇÃO — TENTATIVA DE CORREÇÃO:
A resposta anterior indicou risco de perda de conteúdo.
Nesta tentativa, preserve ainda mais o texto original.
Se uma frase estiver aceitável, mantenha-a.
Corrija apenas erros claros.
`
      : "";

  return `
Você é o HDUD Memory Editorial Curator Engine v2.

MISSÃO:
Atuar como editor, curador, copidesque e revisor de uma memória humana real.

REGRA MÁXIMA:
Você NÃO é resumidor.
Você NÃO é reescritor livre.
Você NÃO é autor substituto.
Você é apenas curador editorial.

${strictness}

NARRATIVE TAXONOMY GRAPH — NTG:
${narrativeContext ? `Esta memória foi classificada pelo autor no caminho narrativo:
- Life Period: ${narrativeContext.life_period.label} (${narrativeContext.life_period.code})
- Editorial Context: ${narrativeContext.editorial_context.label} (${narrativeContext.editorial_context.code})
- Narrative Role: ${narrativeContext.narrative_role.label} (${narrativeContext.narrative_role.code})
- Narrative Path: ${narrativeContext.narrative_path}
${narrativeContext.legacy_path ? `
ATENÇÃO — CAMINHO NARRATIVO LEGADO:
Este caminho pertence a uma versão anterior da taxonomia HDUD.
Utilize-o somente como contexto editorial.
NÃO proponha uma nova classificação.
NÃO reclassifique esta memória.
NÃO tente corrigir ou substituir seus códigos.
A classificação persistida continua soberana e pertence ao autor.
` : ""}
Use essa classificação exclusivamente como contexto editorial.
Refine o texto de forma coerente com o papel narrativo escolhido.
NÃO altere, reclassifique, questione ou substitua o caminho narrativo.
NÃO proponha códigos alternativos.
A classificação pertence exclusivamente ao autor e é imutável para a IA.` : `Nenhum caminho narrativo completo foi fornecido. Não invente classificação narrativa.`}

CONTEXTO:
A memória fornecida é real.
O perfil de voz, quando existir, representa padrões narrativos observados nas memórias reais do autor.

OBJETIVOS PERMITIDOS:
- corrigir ortografia
- corrigir gramática
- corrigir concordância
- corrigir regência
- corrigir pontuação
- corrigir acentuação
- melhorar clareza
- melhorar fluidez
- melhorar ritmo de leitura
- preservar voz do autor
- preservar emoção original
- respeitar o perfil narrativo do autor
- manter naturalidade humana

NORMALIZAÇÃO EDITORIAL

Você atua como um editor literário profissional.

Sua função é preparar este texto para publicação mantendo integralmente a identidade do autor.

Preservar a voz do autor NÃO significa preservar erros de escrita.

Sempre corrija automaticamente:
• erros ortográficos
• erros gramaticais
• erros de concordância
• erros de regência
• erros de pontuação
• abreviações coloquiais
• contrações informais
• acentuação

quando essas alterações NÃO modificarem:
• fatos
• acontecimentos
• contexto
• emoção
• personalidade narrativa
• estilo do autor

Exemplos obrigatórios:
tava → estava
ta → está
pra → para
pro → para o
pros → para os
pras → para as
num → não
dum → de um
agente → a gente
mais (adversativo) → mas
tambem → também
epoca → época
dificil → difícil
historia → história
historias → histórias
memoria → memória
memorias → memórias
morrese → morresse

AUTO-REVISÃO

Antes de responder, releia integralmente o texto refinado.

Caso ainda existam abreviações coloquiais, erros ortográficos, gramaticais, de concordância, regência ou pontuação, corrija-os antes de gerar o JSON final.

REGRAS ABSOLUTAS DE PRESERVAÇÃO:
- NÃO resumir
- NÃO condensar
- NÃO encurtar deliberadamente
- NÃO remover fatos
- NÃO remover detalhes
- NÃO remover nomes
- NÃO remover lugares
- NÃO remover datas
- NÃO remover eventos
- NÃO fundir acontecimentos diferentes
- NÃO alterar acontecimentos
- NÃO adicionar personagens
- NÃO adicionar datas não informadas
- NÃO inventar contexto
- NÃO transformar em texto artificial
- NÃO destruir o estilo do autor
- NÃO exagerar emoção além da intensidade solicitada

POLÍTICA DE CONTEÚDO:
Toda informação presente no original deve continuar presente na versão refinada.
Se houver dúvida entre melhorar ou preservar, preserve.
Se uma frase estiver emocionalmente importante, preserve.
Preserve construções que caracterizam a identidade narrativa do autor.

Não preserve abreviações coloquiais, erros ortográficos, erros gramaticais, erros de concordância, erros de regência ou erros de pontuação quando puder corrigi-los sem alterar a personalidade do narrador.
A memória final pode ficar ligeiramente maior.
A memória final não deve ficar substancialmente menor.

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

${isChunk ? "MODO CHUNK: você está refinando apenas uma parte da memória. Não crie abertura, conclusão ou resumo. Preserve somente esta parte." : ""}

RESPONDA EXCLUSIVAMENTE EM JSON VÁLIDO:

{
  "refined_title": "...",
  "refined_content": "...",
  "voice_preserved": true,
  "voice_profile_used": true,
  "emotional_intensity": 0,
  "changes_summary": [],
  "editorial_changes": [
    {
      "type": "ortografia|gramatica|pontuacao|clareza|fluidez|voz_do_autor|estrutura",
      "title": "Título curto da alteração",
      "before": "OBRIGATÓRIO - trecho original exato",
      "after": "OBRIGATÓRIO - trecho refinado exato",
      "rationale": "explicação objetiva da decisão editorial",
      "impact": "efeito esperado na leitura"
    }
  ],
  "source_policy": "Somente memória real do autor. Sem conteúdo inventado. Sem resumo. Sem perda de conteúdo."
}

REGRA EDITORIAL

Toda correção ortográfica, gramatical, de concordância, regência, pontuação ou normalização linguística relevante deve aparecer em editorial_changes.

Exemplos:

before: "tava"
after: "estava"

before: "pra"
after: "para"

before: "mais"
after: "mas"

before: "epoca"
after: "época"

REGRA OBRIGATÓRIA PARA editorial_changes:
- before é obrigatório.
- after é obrigatório.
- NÃO gere editorial_changes sem before e after.
- Cada alteração precisa mostrar claramente o trecho original e o trecho refinado.
- Use trechos curtos, literais e verificáveis.
- Se não houver trecho específico para demonstrar a alteração, NÃO crie o item.
- Gere até 50 alterações editoriais relevantes quando houver evidência real.

EXEMPLO VÁLIDO:
{
  "type": "ortografia",
  "title": "Correção ortográfica",
  "before": "quiz",
  "after": "quis",
  "rationale": "Correção ortográfica.",
  "impact": "Melhora a leitura e a credibilidade do texto."
}

EXEMPLO VÁLIDO:
{
  "type": "pontuacao",
  "title": "Pontuação e acentuação",
  "before": "ai eu pensei",
  "after": "Aí eu pensei:",
  "rationale": "Ajuste de acentuação e introdução de dois-pontos para organizar a fala interior.",
  "impact": "Melhora a fluidez e a clareza da leitura."
}

EXEMPLO INVÁLIDO:
{
  "type": "ortografia",
  "title": "Correção ortográfica"
}
`;
}

async function callRefiner({
  client,
  payload,
  isChunk = false,
  retryAttempt = 0,
  narrativeContext = null,
  usageContext = null,
}) {
  await assertExternalAIAllowed({ userId: usageContext?.userId, authorId: usageContext?.authorId });
  const response = await client.responses.create({
    model: DEFAULT_MODEL,
    instructions: buildInstructions({ isChunk, retryAttempt, narrativeContext }),
    input: JSON.stringify(payload),
  });

  const usageRecord = await recordExternalAIUsage({
    ...(usageContext || {}),
    operationCode: usageContext?.operationCode || "MEMORY_EDITORIAL_REFINE",
    model: response?.model || DEFAULT_MODEL,
    ...extractOpenAIUsage(response),
    metadata: {
      ...(usageContext?.metadata || {}),
      prompt_version: MEMORY_REFINER_PROMPT_VERSION,
      is_chunk: isChunk,
      retry_attempt: retryAttempt,
    },
  });

  const text = response.output_text || "";
  const parsed = safeJsonParse(text);

  if (!parsed?.refined_content) {
    return {
      ok: false,
      reason: "IA não retornou JSON válido.",
      raw: text,
      ai_usage_id: usageRecord?.recorded ? usageRecord.usageId : null,
    };
  }

  return {
    ok: true,
    raw: text,
    parsed,
    ai_usage_id: usageRecord?.recorded ? usageRecord.usageId : null,
  };
}

function normalizeEditorialChanges(items) {
  return Array.isArray(items)
    ? items
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          type: item.type || item.category || null,
          category: item.category || item.type || null,
          title: item.title || null,
          before: item.before || null,
          after: item.after || null,
          rationale: item.rationale || null,
          impact: item.impact || null,
          confidence: Number.isFinite(Number(item.confidence))
            ? Number(item.confidence)
            : null,
        }))
        .filter(
          (item) =>
            String(item.before || "").trim().length > 0 &&
            String(item.after || "").trim().length > 0
        )
        .slice(0, 50)
    : [];
}

export async function refineMemoryWithOpenAI({
  memory,
  options = {},
  voiceProfile = null,
  narrativeContext = null,
  usageContext = null,
}) {
  if (!hasOpenAIKey()) {
    return {
      ok: false,
      reason: "OPENAI_API_KEY ausente.",
    };
  }

  const client = new OpenAI();
  const normalizedVoiceProfile = normalizeVoiceProfile(voiceProfile);
  const normalizedNarrativeContext = await resolveRefinementNarrativeContext(memory, narrativeContext);
  const originalContent = normalizeText(memory.content || "");
  const chunks = splitMemoryIntoEditorialChunks(originalContent);
  const aiUsageIds = [];

  const baseOptions = {
    mode: options.mode || "editorial",
    preserve_voice: options.preserve_voice !== false,
    intensity: Number(options.intensity || 7),
    language:
      options.language ||
      normalizedVoiceProfile?.preferred_language ||
      "pt-BR",
    narrative_taxonomy_policy: {
      use_as_editorial_context: true,
      preserve_author_classification: true,
      allow_ai_reclassification: false,
      author_sovereignty: true,
    },
    preservation_policy: {
      no_summary: true,
      no_condensation: true,
      no_fact_removal: true,
      no_detail_removal: true,
      minimum_ratio: MIN_PRESERVATION_RATIO,
    },
  };

  if (chunks.length > 1) {
    const refinedChunks = [];
    const allChanges = [];
    const summaries = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];

      const payload = {
        memory: {
          memory_id: Number(memory.memory_id),
          title: memory.title || null,
          content: chunk,
          phase_code: memory.phase_code || null,
          chunk_index: index + 1,
          total_chunks: chunks.length,
        },
        options: baseOptions,
        voice_profile: normalizedVoiceProfile,
        narrative_context: normalizedNarrativeContext,
      };

      let accepted = null;
      let lastFailure = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const ai = await callRefiner({
          client,
          payload,
          isChunk: true,
          retryAttempt: attempt,
          narrativeContext: normalizedNarrativeContext,
          usageContext: {
            ...(usageContext || {}),
            authorId: usageContext?.authorId ?? memory?.author_id,
            operationCode:
              usageContext?.operationCode ||
              (options?.mode === "memory_audio_editorial_refine"
                ? "AUDIO_EDITORIAL_REFINE"
                : "MEMORY_EDITORIAL_REFINE"),
            entityType: usageContext?.entityType || "MEMORY",
            entityId: usageContext?.entityId ?? memory?.memory_id,
          },
        });

        if (ai?.ai_usage_id) aiUsageIds.push(Number(ai.ai_usage_id));

        if (!ai.ok) {
          lastFailure = ai;
          continue;
        }

        const guard = validateContentPreservation(
          chunk,
          ai.parsed.refined_content
        );

        if (!guard.ok) {
          lastFailure = {
            ok: false,
            reason: guard.reason,
            editorial_guard: guard.stats,
          };
          continue;
        }

        accepted = {
          parsed: ai.parsed,
          guard: guard.stats,
          ai_usage_id: ai.ai_usage_id || null,
        };
        break;
      }

      if (!accepted) {
        return {
          ok: false,
          reason:
            lastFailure?.reason ||
            "Falha ao refinar chunk sem perda de conteúdo.",
          chunk_index: index + 1,
          total_chunks: chunks.length,
          editorial_guard: lastFailure?.editorial_guard || null,
          raw: lastFailure?.raw || null,
        };
      }

      refinedChunks.push(normalizeText(accepted.parsed.refined_content));

      if (Array.isArray(accepted.parsed.changes_summary)) {
        summaries.push(...accepted.parsed.changes_summary);
      }

      allChanges.push(...normalizeEditorialChanges(accepted.parsed.editorial_changes));
    }

    const refinedContent = refinedChunks.join("\n\n");
    const finalGuard = validateContentPreservation(originalContent, refinedContent);

    if (!finalGuard.ok) {
      return {
        ok: false,
        reason: finalGuard.reason,
        editorial_guard: finalGuard.stats,
      };
    }

    return {
      ok: true,
      model: DEFAULT_MODEL,
      prompt_version: MEMORY_REFINER_PROMPT_VERSION,
      ai_usage_ids: aiUsageIds,
      primary_ai_usage_id: aiUsageIds.length ? aiUsageIds[aiUsageIds.length - 1] : null,
      editorial_guard: finalGuard.stats,
      result: {
        refined_title: memory.title || null,
        refined_content: refinedContent,
        voice_preserved: true,
        voice_profile_used: Boolean(normalizedVoiceProfile),
        narrative_context_used: Boolean(normalizedNarrativeContext),
        narrative_context: normalizedNarrativeContext,
        classification_preserved: true,
        emotional_intensity: Number(options.intensity || 7),
        changes_summary: summaries.slice(0, 20),
        editorial_changes: allChanges.slice(0, 50),
        source_policy:
          "Somente memória real do autor. Sem conteúdo inventado. Sem resumo. Sem perda de conteúdo.",
      },
    };
  }

  const payload = {
    memory: {
      memory_id: Number(memory.memory_id),
      title: memory.title || null,
      content: originalContent,
      phase_code: memory.phase_code || null,
    },
    options: baseOptions,
    voice_profile: normalizedVoiceProfile,
    narrative_context: normalizedNarrativeContext,
  };

  let accepted = null;
  let lastFailure = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const ai = await callRefiner({
      client,
      payload,
      isChunk: false,
      retryAttempt: attempt,
      narrativeContext: normalizedNarrativeContext,
      usageContext: {
        ...(usageContext || {}),
        authorId: usageContext?.authorId ?? memory?.author_id,
        operationCode:
          usageContext?.operationCode ||
          (options?.mode === "memory_audio_editorial_refine"
            ? "AUDIO_EDITORIAL_REFINE"
            : "MEMORY_EDITORIAL_REFINE"),
        entityType: usageContext?.entityType || "MEMORY",
        entityId: usageContext?.entityId ?? memory?.memory_id,
      },
    });

    if (ai?.ai_usage_id) aiUsageIds.push(Number(ai.ai_usage_id));

    if (!ai.ok) {
      lastFailure = ai;
      continue;
    }

    const guard = validateContentPreservation(
      originalContent,
      ai.parsed.refined_content
    );

    if (!guard.ok) {
      lastFailure = {
        ok: false,
        reason: guard.reason,
        editorial_guard: guard.stats,
      };
      continue;
    }

    accepted = {
      parsed: ai.parsed,
      guard: guard.stats,
      ai_usage_id: ai.ai_usage_id || null,
    };
    break;
  }

  if (!accepted) {
    return {
      ok: false,
      reason:
        lastFailure?.reason ||
        "IA retornou sugestão com risco de perda de conteúdo.",
      editorial_guard: lastFailure?.editorial_guard || null,
      raw: lastFailure?.raw || null,
    };
  }

  const parsed = accepted.parsed;

  return {
    ok: true,
    model: DEFAULT_MODEL,
    prompt_version: MEMORY_REFINER_PROMPT_VERSION,
    ai_usage_ids: aiUsageIds,
    primary_ai_usage_id: accepted.ai_usage_id || (aiUsageIds.length ? aiUsageIds[aiUsageIds.length - 1] : null),
    editorial_guard: accepted.guard,
    result: {
      refined_title: parsed.refined_title || memory.title || null,
      refined_content: parsed.refined_content,
      voice_preserved: parsed.voice_preserved !== false,
      voice_profile_used: Boolean(normalizedVoiceProfile),
      narrative_context_used: Boolean(normalizedNarrativeContext),
      narrative_context: normalizedNarrativeContext,
      classification_preserved: true,
      emotional_intensity:
        Number.isFinite(Number(parsed.emotional_intensity))
          ? Number(parsed.emotional_intensity)
          : Number(options.intensity || 7),
      changes_summary: Array.isArray(parsed.changes_summary)
        ? parsed.changes_summary
        : [],
      editorial_changes: normalizeEditorialChanges(parsed.editorial_changes).slice(
        0,
        50
      ),
      source_policy:
        parsed.source_policy ||
        "Somente memória real do autor. Sem conteúdo inventado. Sem resumo. Sem perda de conteúdo.",
    },
  };
}