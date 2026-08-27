import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";

function stripJsonFence(value = '') {
  return String(value || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function parseOpenAIJson(value) {
  if (typeof value === 'object' && value !== null) return value;

  try {
    return JSON.parse(stripJsonFence(value));
  } catch {
    return {
      title: 'História em revisão',
      manuscript: [],
      warnings: ['A resposta da IA não retornou JSON válido.'],
      raw_response: String(value || ''),
    };
  }
}

export async function generateStoryWithOpenAI({ openai, prompt, model = process.env.OPENAI_MODEL || 'gpt-4.1', usageContext = null }) {
  if (!openai?.responses?.create) {
    throw new Error('OpenAI client not configured for StoryTruthOpenAIAdapter');
  }

  await assertExternalAIAllowed({ userId: usageContext?.userId, authorId: usageContext?.authorId });
  const completion = await openai.responses.create({
    model,
    input: prompt,
  });

  await recordExternalAIUsage({
    ...(usageContext || {}), operationCode: usageContext?.operationCode || "STORY_TRUTH_GENERATION",
    model: completion?.model || model, ...extractOpenAIUsage(completion),
  });

  return completion.output_text;
}
