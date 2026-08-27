// C:\HDUD_DATA\hdud-api-node\src\services\story\truth-validator.service.js
//
// GO LIVE 003.4 — Truth Validator
// Responsabilidade: validar se a História gerada permanece sustentada pelas memórias.

import { buildEvidenceMap } from "./story-evidence.service.js";

export const TRUTH_VALIDATOR_ENGINE_VERSION = "truth-validator-v1.0-go-live-003.4";

const BLOCKED_CAUSALITY_TERMS = [
  "por isso", "por causa disso", "isso fez com que", "foi então que", "a partir daí", "a partir dai",
  "desde então", "desde entao", "como consequência", "como consequencia", "por consequência", "por consequencia",
  "levou a", "resultou em", "determinou", "provou que", "mostra que ele sentia", "mostra que ela sentia",
];

const EMOTION_TERMS = [
  "feliz", "triste", "orgulhoso", "orgulhosa", "culpado", "culpada", "arrependido", "arrependida",
  "apaixonado", "apaixonada", "com medo", "ansioso", "ansiosa", "emocionado", "emocionada",
  "aliviado", "aliviada", "frustrado", "frustrada", "magoado", "magoada",
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function memoryCorpus(memories = []) {
  return normalize(safeArray(memories).map((memory) => [memory?.title, memory?.content, memory?.description, memory?.summary].filter(Boolean).join(" ")).join("\n"));
}

function splitSentences(text) {
  return safeText(text, "")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findUnsupportedTerms({ narrativeContent, memories, terms, type }) {
  const corpus = memoryCorpus(memories);
  const normalizedContent = normalize(narrativeContent);

  return terms
    .filter((term) => normalizedContent.includes(normalize(term)) && !corpus.includes(normalize(term)))
    .map((term) => ({ type, term }));
}

function findUnsupportedYears({ narrativeContent, memories }) {
  const contentYears = [...new Set((safeText(narrativeContent, "").match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2}|2200)\b/g) || []))];
  const memoryYears = new Set((memoryCorpus(memories).match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2}|2200)\b/g) || []));
  return contentYears
    .filter((year) => !memoryYears.has(year))
    .map((year) => ({ type: "unsupported_date", term: year }));
}

function findWeakSentences({ narrativeContent, memories }) {
  const corpus = memoryCorpus(memories);
  return splitSentences(narrativeContent)
    .map((sentence, index) => {
      const tokens = normalize(sentence).split(/[^a-z0-9]+/).filter((token) => token.length >= 5);
      const hits = tokens.filter((token) => corpus.includes(token)).length;
      const supportRatio = tokens.length ? hits / tokens.length : 0;
      return { sentence_index: index + 1, sentence, support_ratio: supportRatio };
    })
    .filter((item) => item.support_ratio < 0.12 && item.sentence.length > 80)
    .slice(0, 8);
}

export function validateStoryTruth({ narrativeContent = "", memories = [], memoryScores = [] } = {}) {
  const issues = [
    ...findUnsupportedTerms({ narrativeContent, memories, terms: BLOCKED_CAUSALITY_TERMS, type: "created_causality" }),
    ...findUnsupportedTerms({ narrativeContent, memories, terms: EMOTION_TERMS, type: "created_emotion" }),
    ...findUnsupportedYears({ narrativeContent, memories }),
  ];

  const weakSentences = findWeakSentences({ narrativeContent, memories });
  const evidenceMap = buildEvidenceMap({ narrativeContent, memories, memoryScores });

  const unsupportedPenalty = evidenceMap.unsupported_paragraphs * 8;
  const issuePenalty = issues.length * 7;
  const weakPenalty = weakSentences.length * 4;
  const hallucinationRisk = Math.max(0, Math.min(100, unsupportedPenalty + issuePenalty + weakPenalty));

  const rejected = issues.length >= 4 || hallucinationRisk >= 45 || evidenceMap.evidence_quality < 45;

  return {
    ok: !rejected,
    decision: rejected ? "REJECT" : "ACCEPT",
    engine: TRUTH_VALIDATOR_ENGINE_VERSION,
    hallucination_risk: hallucinationRisk,
    evidence_quality: evidenceMap.evidence_quality,
    issues,
    weak_sentences: weakSentences,
    evidence_map: evidenceMap,
    validation_policy: "Toda frase deve estar sustentada por uma ou mais memórias. Quando não houver evidência suficiente, escreva menos.",
  };
}

export const TruthValidatorService = {
  validateStoryTruth,
};
