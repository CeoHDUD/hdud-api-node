// C:\HDUD_DATA\hdud-api-node\src\narrative\intelligence\application\build-narrative-intelligence.usecase.js

import { buildNarrativeIntelligence } from "../services/narrative-intelligence.service.js";

export async function buildNarrativeIntelligenceUseCase(input = {}) {
  return buildNarrativeIntelligence(input);
}

export const BuildNarrativeIntelligenceUseCase = {
  execute: buildNarrativeIntelligenceUseCase,
};
