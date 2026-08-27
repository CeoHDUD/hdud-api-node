// C:\HDUD_DATA\hdud-api-node\src\services\generative\generative-editorial.service.js

import { normalizeGenerativeInput, createGenerativeOutput } from "./generative-contracts.js";
import { cleanGenerativeInput } from "./generative-cleaner.service.js";
import { estimateAndCompactGenerativeInput } from "./generative-token-estimator.service.js";
import { buildGenerativeEditorialPrompt } from "./generative-prompt-builder.service.js";
import { generateManuscriptWithOpenAI } from "./generative-openai.service.js";

export async function generateEditorialManuscript(input = {}, options = {}) {
  const normalized = normalizeGenerativeInput(input);
  const cleaned = cleanGenerativeInput(normalized);

  if (!cleaned.memories.length) {
    const error = new Error("As memórias aprovadas não possuem texto narrativo válido.");
    error.statusCode = 422;
    error.code = "GENERATIVE_MEMORIES_EMPTY_AFTER_CLEANING";
    throw error;
  }

  const prepared = estimateAndCompactGenerativeInput(cleaned, {
    maxPromptTokens: options?.maxPromptTokens,
  });

  const prompt = buildGenerativeEditorialPrompt(prepared);
  const generated = await generateManuscriptWithOpenAI({ ...prompt, usageContext: options?.usageContext || null });

  return createGenerativeOutput(generated);
}
