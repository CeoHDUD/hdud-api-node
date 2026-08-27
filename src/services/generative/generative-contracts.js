// C:\HDUD_DATA\hdud-api-node\src\services\generative\generative-contracts.js
//
// GO LIVE 008.3 — CHAT 01
// Generative Editorial Engine Foundation

export const GENERATIVE_INPUT_FIELDS = Object.freeze([
  "title",
  "centralQuestion",
  "memories",
]);

export const GENERATIVE_OUTPUT_FIELDS = Object.freeze([
  "manuscript",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "model",
  "provider",
  "operationCode",
  "aiUsageId",
  "usageRecorded",
]);

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeText(item, ""))
    .filter(Boolean);
}

export function normalizeGenerativeInput(input = {}) {
  const memories = asStringArray(input?.memories);

  if (!memories.length) {
    const error = new Error("Ao menos uma memória aprovada é obrigatória para gerar o manuscrito.");
    error.statusCode = 422;
    error.code = "GENERATIVE_MEMORIES_REQUIRED";
    throw error;
  }

  return {
    title: safeText(input?.title, ""),
    centralQuestion: safeText(input?.centralQuestion, ""),
    memories,
  };
}

export function createGenerativeOutput({
  manuscript,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  model = "",
  provider = "",
  operationCode = "",
  aiUsageId = null,
  usageRecorded = false,
} = {}) {
  const normalizedManuscript = safeText(manuscript, "");

  if (!normalizedManuscript) {
    const error = new Error("A IA Generativa não retornou um manuscrito válido.");
    error.statusCode = 502;
    error.code = "GENERATIVE_MANUSCRIPT_EMPTY";
    throw error;
  }

  return {
    manuscript: normalizedManuscript,
    promptTokens: Math.max(0, Number(promptTokens) || 0),
    completionTokens: Math.max(0, Number(completionTokens) || 0),
    totalTokens: Math.max(0, Number(totalTokens) || 0),
    model: safeText(model, "unknown"),
    provider: safeText(provider, ""),
    operationCode: safeText(operationCode, ""),
    aiUsageId: Number.isFinite(Number(aiUsageId)) && Number(aiUsageId) > 0 ? Number(aiUsageId) : null,
    usageRecorded: Boolean(usageRecorded),
  };
}
