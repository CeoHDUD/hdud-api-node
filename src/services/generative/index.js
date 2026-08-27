// C:\HDUD_DATA\hdud-api-node\src\services\generative\index.js

export {
  GENERATIVE_INPUT_FIELDS,
  GENERATIVE_OUTPUT_FIELDS,
  normalizeGenerativeInput,
  createGenerativeOutput,
} from "./generative-contracts.js";

export {
  cleanNarrativeText,
  cleanGenerativeInput,
} from "./generative-cleaner.service.js";

export {
  estimateTokens,
  compactGenerativeInput,
  estimateAndCompactGenerativeInput,
} from "./generative-token-estimator.service.js";

export { buildGenerativeEditorialPrompt } from "./generative-prompt-builder.service.js";

export {
  generateManuscriptWithOpenAI,
  getGenerativeOpenAIConfiguration,
} from "./generative-openai.service.js";

export { generateEditorialManuscript } from "./generative-editorial.service.js";
