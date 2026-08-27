// C:\HDUD_DATA\hdud-api-node\src\services\generative\generative-openai.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";

const MODEL = process.env.GENERATIVE_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1";
const TEMPERATURE = Number(process.env.GENERATIVE_OPENAI_TEMPERATURE || 0.25);
const MAX_OUTPUT_TOKENS = Number(process.env.GENERATIVE_OPENAI_MAX_TOKENS || 6000);
const TIMEOUT_MS = Number(process.env.GENERATIVE_OPENAI_TIMEOUT_MS || 120000);
const MAX_RETRIES = Number(process.env.GENERATIVE_OPENAI_RETRIES || 2);

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

function createClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
}

function readUsage(response = {}) {
  const usage = response?.usage || {};
  const promptTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens) || promptTokens + completionTokens;

  return { promptTokens, completionTokens, totalTokens };
}

export async function generateManuscriptWithOpenAI({ system, user, usageContext = null } = {}) {
  if (!hasOpenAIKey()) {
    const error = new Error("OPENAI_API_KEY não configurada no ambiente da API.");
    error.statusCode = 503;
    error.code = "GENERATIVE_OPENAI_NOT_CONFIGURED";
    throw error;
  }

  try {
    const client = createClient();
    await assertExternalAIAllowed({ userId: usageContext?.userId, authorId: usageContext?.authorId });
    const response = await client.responses.create({
      model: MODEL,
      temperature: TEMPERATURE,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      instructions: String(system || ""),
      input: String(user || ""),
    });

    const measured = extractOpenAIUsage(response);
    const operationCode = usageContext?.operationCode || "EDITORIAL_MANUSCRIPT_GENERATION";
    const actualModel = response?.model || MODEL;
    const usageRecord = await recordExternalAIUsage({
      ...(usageContext || {}),
      operationCode,
      model: actualModel,
      ...measured,
    });

    return {
      manuscript: String(response?.output_text || "").trim(),
      model: actualModel,
      provider: "OPENAI",
      operationCode,
      aiUsageId: usageRecord?.recorded ? Number(usageRecord.usageId) || null : null,
      usageRecorded: Boolean(usageRecord?.recorded),
      ...readUsage(response),
    };
  } catch (cause) {
    const error = new Error(cause?.message || "Falha ao gerar manuscrito com a OpenAI.");
    error.statusCode = Number(cause?.status) || 503;
    error.code = cause?.code || "GENERATIVE_OPENAI_FAILURE";
    error.cause = cause;
    throw error;
  }
}

export function getGenerativeOpenAIConfiguration() {
  return {
    model: MODEL,
    temperature: TEMPERATURE,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: TIMEOUT_MS,
    retries: MAX_RETRIES,
  };
}
