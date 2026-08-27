// C:\HDUD_DATA\hdud-api-node\src\services\generative\generative-token-estimator.service.js

const DEFAULT_MAX_PROMPT_TOKENS = Number(process.env.GENERATIVE_MAX_PROMPT_TOKENS || 12000);
const TOKEN_CHAR_RATIO = 4;

function safePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function estimateTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / TOKEN_CHAR_RATIO));
}

function truncateTextToTokens(value, tokenBudget) {
  const budget = Math.max(0, Number(tokenBudget) || 0);
  if (!budget) return "";

  const text = String(value ?? "").trim();
  if (estimateTokens(text) <= budget) return text;

  const maxCharacters = Math.max(1, budget * TOKEN_CHAR_RATIO);
  const sliced = text.slice(0, maxCharacters);
  const boundary = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("! "),
    sliced.lastIndexOf("? "),
    sliced.lastIndexOf("\n")
  );

  return (boundary > maxCharacters * 0.6 ? sliced.slice(0, boundary + 1) : sliced).trim();
}

export function compactGenerativeInput(input = {}, options = {}) {
  const maxPromptTokens = safePositiveInt(options.maxPromptTokens, DEFAULT_MAX_PROMPT_TOKENS);
  const title = String(input?.title ?? "").trim();
  const centralQuestion = String(input?.centralQuestion ?? "").trim();
  const memories = Array.isArray(input?.memories) ? input.memories.map((item) => String(item ?? "").trim()).filter(Boolean) : [];

  const fixedText = [title, centralQuestion].filter(Boolean).join("\n");
  const fixedTokens = estimateTokens(fixedText) + 400;
  const availableForMemories = Math.max(256, maxPromptTokens - fixedTokens);

  const perMemoryBudget = Math.max(128, Math.floor(availableForMemories / Math.max(1, memories.length)));
  const compactedMemories = memories.map((memory) => truncateTextToTokens(memory, perMemoryBudget)).filter(Boolean);

  return {
    title: truncateTextToTokens(title, 256),
    centralQuestion: truncateTextToTokens(centralQuestion, 512),
    memories: compactedMemories,
    estimatedTokens: estimateTokens([title, centralQuestion, ...compactedMemories].join("\n\n")),
    compacted: compactedMemories.some((memory, index) => memory.length < memories[index].length),
    maxPromptTokens,
  };
}

export function estimateAndCompactGenerativeInput(input = {}, options = {}) {
  const rawText = [input?.title, input?.centralQuestion, ...(Array.isArray(input?.memories) ? input.memories : [])]
    .filter(Boolean)
    .join("\n\n");
  const estimatedTokens = estimateTokens(rawText);
  const maxPromptTokens = safePositiveInt(options.maxPromptTokens, DEFAULT_MAX_PROMPT_TOKENS);

  if (estimatedTokens <= maxPromptTokens) {
    return {
      ...input,
      estimatedTokens,
      compacted: false,
      maxPromptTokens,
    };
  }

  return compactGenerativeInput(input, { maxPromptTokens });
}
