// C:\HDUD_DATA\hdud-api-node\src\services\story\story-continuity.service.js
//
// GO LIVE 006.3 — Story Continuity Service — Narrative Signal Extraction v2
// Responsabilidade: extrair sinais narrativos de memórias reais e medir continuidade entre conjuntos.
//
// Objetivo desta versão:
// - preservar compatibilidade com os motores existentes;
// - enriquecer extractNarrativeSignals() com sinais narrativos semânticos;
// - reduzir dependência de keywords específicas;
// - permitir que Story Hypothesis / Discovery trabalhem com transformação humana.

const PEOPLE_HINTS = [
  "bruna", "felipe", "zezo", "pai", "mae", "mãe", "filho", "filha", "esposa", "familia", "família",
  "avo", "avó", "avô", "irmao", "irmão", "irma", "irmã", "amigo", "amiga", "professor", "professora",
  "companheira", "companheiro", "namorada", "namorado", "mulher", "marido"
];

const CONTEXT_HINTS = [
  "casamento", "namoro", "lapa", "casa", "familia", "família", "viagem", "trabalho", "carreira",
  "hospital", "cirurgia", "recuperacao", "recuperação", "cbf", "reserva", "hdud", "sql", "dba",
  "escola", "faculdade", "aula", "profissao", "profissão", "livro", "plataforma", "legado"
];

const TRANSFORMATION_HINTS = [
  "mudei", "mudou", "transformei", "transformação", "transformacao", "aprendi", "percebi", "descobri",
  "cresci", "evolui", "recomecei", "recomeço", "recomeco", "decidi", "decisão", "decisao",
  "entendi", "compreendi", "me tornei", "passei a", "nunca mais", "a partir daquele", "a partir disso"
];

const CONSEQUENCE_HINTS = [
  "desde então", "desde entao", "a partir", "por isso", "consequencia", "consequência", "resultado",
  "nunca mais", "passei a", "comecei a", "decidi", "mudou minha vida", "me tornei", "isso me levou",
  "depois disso", "daquele dia", "a partir daquele dia"
];

const EMOTIONAL_HINTS = [
  "amor", "dor", "medo", "alegria", "saudade", "orgulho", "esperança", "esperanca", "perda",
  "felicidade", "tristeza", "ansiedade", "paz", "gratidão", "gratidao", "superação", "superacao",
  "raiva", "culpa", "vergonha", "alivio", "alívio", "coragem", "solidão", "solidao"
];

const OPERATIONAL_HINTS = [
  "docker", "build", "api", "erro", "log", "sistema", "interface", "tela", "print", "screenshot",
  "prompt", "teste", "testando", "deploy", "container", "rota", "endpoint"
];

const SIGNAL_PATTERNS = [
  {
    type: "ORIGIN",
    label: "origem",
    terms: ["primeiro", "primeira", "comecei", "começo", "inicio", "início", "nasceu", "origem", "criei", "fundador", "fundadora"],
    question: "Como tudo começou?",
  },
  {
    type: "DISCOVERY",
    label: "descoberta",
    terms: ["descobri", "percebi", "entendi", "compreendi", "me dei conta", "notei", "aprendi"],
    question: "O que descobri sobre mim nesse momento?",
  },
  {
    type: "TURNING_POINT",
    label: "virada",
    terms: ["virada", "mudou", "transformou", "nunca mais", "a partir", "decidi", "decisão", "decisao", "recomecei"],
    question: "Quando algo mudou definitivamente?",
  },
  {
    type: "IDENTITY_SHIFT",
    label: "mudança de identidade",
    terms: ["me tornei", "passei a ser", "quem eu sou", "identidade", "profissão", "profissao", "vocação", "vocacao"],
    question: "Quando comecei a me reconhecer de outro jeito?",
  },
  {
    type: "RELATIONSHIP",
    label: "relação humana",
    terms: ["amor", "esposa", "marido", "filho", "pai", "mãe", "mae", "família", "familia", "parceria", "junto", "juntos", "companheira", "companheiro"],
    question: "Como essa relação transformou minha vida?",
  },
  {
    type: "LOSS",
    label: "perda",
    terms: ["perda", "perdi", "luto", "saudade", "morte", "despedida", "falta", "acabou"],
    question: "O que essa perda mudou em mim?",
  },
  {
    type: "HEALTH_CROSSING",
    label: "travessia de saúde",
    terms: ["dor", "cirurgia", "hospital", "internação", "internacao", "recuperação", "recuperacao", "medo", "coluna", "l5"],
    question: "Como a dor mudou minha forma de viver?",
  },
  {
    type: "VOCATION",
    label: "vocação",
    terms: ["trabalho", "carreira", "profissão", "profissao", "dba", "sql", "banco", "vocação", "vocacao", "ofício", "oficio"],
    question: "Quando minha profissão passou a fazer parte de quem eu sou?",
  },
  {
    type: "LEGACY",
    label: "legado",
    terms: ["legado", "história", "historia", "memória", "memoria", "livro", "filho saber", "deixar", "autobiografia"],
    question: "Que legado eu queria deixar?",
  },
  {
    type: "RESILIENCE",
    label: "resiliência",
    terms: ["superei", "superação", "superacao", "venci", "levantei", "recomeço", "recomeco", "força", "forca", "coragem"],
    question: "Como aprendi a continuar?",
  },
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length ? text : fallback;
}

export function normalizeKey(value) {
  return normalizeText(value, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryIdOf(memory) {
  const n = Number(memory?.memory_id ?? memory?.id ?? memory?.memoryId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function memoryCanonicalDate(memory) {
  return memory?.memory_date || memory?.narrative_date || memory?.created_at || memory?.published_at || null;
}

export function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function safeYear(value) {
  const date = safeDate(value);
  if (date) return date.getUTCFullYear();
  const match = String(value || "").match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2}|2200)\b/);
  return match ? Number(match[1]) : null;
}

export function compareMemoryDate(a, b) {
  const ad = safeDate(memoryCanonicalDate(a));
  const bd = safeDate(memoryCanonicalDate(b));
  if (ad && bd && ad.getTime() !== bd.getTime()) return ad.getTime() - bd.getTime();
  return (memoryIdOf(a) || 0) - (memoryIdOf(b) || 0);
}

export function memoryText(memory) {
  return normalizeText([
    memory?.title,
    memory?.content,
    memory?.description,
    memory?.summary,
    memory?.transcription_text,
  ].filter(Boolean).join("\n"), "");
}

function tokenize(text) {
  const stop = new Set([
    "para", "com", "uma", "como", "que", "por", "dos", "das", "mais", "menos", "muito", "muita",
    "vida", "memoria", "memorias", "historia", "historias", "capitulo", "capitulos", "quando", "onde",
    "porque", "entao", "ainda", "sobre", "esse", "essa", "isso", "aquilo", "minha", "meu", "meus", "minhas",
    "dele", "dela", "eles", "elas", "este", "esta", "anos", "ano", "dia", "dias", "tudo", "todos", "todas",
    "aqui", "ali", "sempre", "nunca", "coisa", "coisas", "parte", "vezes", "forma", "momento"
  ]);

  return normalizeKey(text)
    .split(/\s+/)
    .filter((word) => word && word.length >= 4 && !stop.has(word) && !/^\d+$/.test(word));
}

function countHints(normalizedText, hints) {
  return hints.reduce((total, hint) => normalizedText.includes(normalizeKey(hint)) ? total + 1 : total, 0);
}

function unique(values) {
  return [...new Set(safeArray(values).filter(Boolean))];
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function termHits(normalized, terms = []) {
  return safeArray(terms)
    .map((term) => normalizeKey(term))
    .filter(Boolean)
    .filter((term) => normalized.includes(term));
}

function signalConfidence({ hits = [], wordCount = 0, hasNarrativeShape = false, emotionalCount = 0, transformationCount = 0, consequenceCount = 0 }) {
  let score = 0;
  score += Math.min(46, hits.length * 17);
  score += Math.min(18, Math.round(wordCount / 16));
  if (hasNarrativeShape) score += 14;
  score += Math.min(12, emotionalCount * 4);
  score += Math.min(10, transformationCount * 5);
  score += Math.min(8, consequenceCount * 4);
  return clampScore(score);
}

function detectNarrativeShape(normalized) {
  return Boolean(
    normalized.includes("quando ") ||
    normalized.includes("depois") ||
    normalized.includes("naquele") ||
    normalized.includes("a partir") ||
    normalized.includes("foi entao") ||
    normalized.includes("foi então") ||
    normalized.includes("percebi") ||
    normalized.includes("entendi") ||
    normalized.includes("aprendi") ||
    normalized.includes("nunca mais")
  );
}

function buildNarrativeSignals({ normalized, wordCount, transformationCount, consequenceCount, emotionalCount }) {
  const hasNarrativeShape = detectNarrativeShape(normalized);
  const signals = [];

  for (const pattern of SIGNAL_PATTERNS) {
    const hits = termHits(normalized, pattern.terms);
    if (!hits.length) continue;

    const confidence = signalConfidence({
      hits,
      wordCount,
      hasNarrativeShape,
      emotionalCount,
      transformationCount,
      consequenceCount,
    });

    if (confidence < 28) continue;

    signals.push({
      type: pattern.type,
      label: pattern.label,
      confidence,
      terms: hits.slice(0, 8),
      suggested_question: pattern.question,
    });
  }

  if (transformationCount > 0 && !signals.some((signal) => signal.type === "IDENTITY_SHIFT" || signal.type === "TURNING_POINT")) {
    signals.push({
      type: "TRANSFORMATION",
      label: "transformação",
      confidence: clampScore(46 + transformationCount * 16 + (hasNarrativeShape ? 12 : 0)),
      terms: [],
      suggested_question: "Que transformação esta memória revela?",
    });
  }

  if (consequenceCount > 0 && !signals.some((signal) => signal.type === "CONSEQUENCE")) {
    signals.push({
      type: "CONSEQUENCE",
      label: "consequência",
      confidence: clampScore(42 + consequenceCount * 16 + (hasNarrativeShape ? 10 : 0)),
      terms: [],
      suggested_question: "O que mudou depois disso?",
    });
  }

  return signals
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || String(a.type).localeCompare(String(b.type), "pt-BR"))
    .slice(0, 8);
}

function buildSignalGroups(narrativeSignals = []) {
  const signals = safeArray(narrativeSignals);
  return {
    identityShifts: signals.filter((signal) => ["IDENTITY_SHIFT", "VOCATION", "LEGACY"].includes(signal.type)),
    turningPoints: signals.filter((signal) => ["TURNING_POINT", "ORIGIN", "DISCOVERY"].includes(signal.type)),
    relationships: signals.filter((signal) => signal.type === "RELATIONSHIP"),
    conflicts: signals.filter((signal) => ["LOSS", "HEALTH_CROSSING"].includes(signal.type)),
    consequences: signals.filter((signal) => ["CONSEQUENCE", "RESILIENCE"].includes(signal.type)),
    lifeThemes: signals.filter((signal) => ["LEGACY", "VOCATION", "RELATIONSHIP", "HEALTH_CROSSING", "LOSS", "RESILIENCE"].includes(signal.type)),
    questions: unique(signals.map((signal) => signal.suggested_question)).slice(0, 6),
  };
}

export function extractNarrativeSignals(memory) {
  const text = memoryText(memory);
  const normalized = normalizeKey(text);
  const words = tokenize(text);
  const freq = new Map();

  for (const word of words) freq.set(word, (freq.get(word) || 0) + 1);

  const keywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))
    .slice(0, 12)
    .map(([word]) => word);

  const characters = PEOPLE_HINTS.filter((hint) => normalized.includes(normalizeKey(hint))).map(normalizeKey);
  const contexts = CONTEXT_HINTS.filter((hint) => normalized.includes(normalizeKey(hint))).map(normalizeKey);
  const transformationCount = countHints(normalized, TRANSFORMATION_HINTS);
  const consequenceCount = countHints(normalized, CONSEQUENCE_HINTS);
  const emotionalCount = countHints(normalized, EMOTIONAL_HINTS);
  const operationalCount = countHints(normalized, OPERATIONAL_HINTS);

  const narrativeSignals = buildNarrativeSignals({
    normalized,
    wordCount: words.length,
    transformationCount,
    consequenceCount,
    emotionalCount,
  });

  const groups = buildSignalGroups(narrativeSignals);
  const signalScore = clampScore(
    narrativeSignals.reduce((sum, signal) => sum + Number(signal.confidence || 0), 0) / Math.max(1, narrativeSignals.length)
  );
  const narrativeDensity = clampScore(
    signalScore + Math.min(15, transformationCount * 4) + Math.min(12, consequenceCount * 3) + Math.min(10, emotionalCount * 2) - Math.min(25, operationalCount * 8)
  );

  return {
    memory_id: memoryIdOf(memory),
    title: memory?.title || `Memória ${memoryIdOf(memory) || ""}`.trim(),
    date: memoryCanonicalDate(memory),
    year: safeYear(memoryCanonicalDate(memory)),
    text,
    normalized,
    keywords,
    characters: unique(characters),
    contexts: unique(contexts),
    transformation_count: transformationCount,
    consequence_count: consequenceCount,
    emotional_count: emotionalCount,
    operational_count: operationalCount,
    word_count: words.length,

    // GO LIVE 006.3 — enriched signals
    narrativeSignals,
    identityShifts: groups.identityShifts,
    turningPoints: groups.turningPoints,
    relationships: groups.relationships,
    conflicts: groups.conflicts,
    consequences: groups.consequences,
    lifeThemes: groups.lifeThemes,
    questions: groups.questions,
    narrative_signal_score: signalScore,
    narrative_density: narrativeDensity,
    signal_types: unique(narrativeSignals.map((signal) => signal.type)),
  };
}

function overlapScore(a = [], b = []) {
  const left = new Set(safeArray(a));
  const right = new Set(safeArray(b));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const item of left) if (right.has(item)) common += 1;
  return common / Math.max(1, Math.min(left.size, right.size));
}

function temporalContinuityScore(signals = []) {
  const years = safeArray(signals).map((signal) => signal.year).filter(Boolean).sort((a, b) => a - b);
  if (years.length <= 1) return 0.45;
  const span = Math.max(1, years[years.length - 1] - years[0] + 1);
  const density = Math.min(1, years.length / Math.max(2, span));
  const hasProgression = years[0] !== years[years.length - 1] ? 1 : 0.65;
  return Number(Math.min(1, (density * 0.55) + (hasProgression * 0.45)).toFixed(3));
}

function signalTypeContinuity(signals = []) {
  const types = safeArray(signals).flatMap((signal) => safeArray(signal.signal_types));
  if (!types.length) return 0;
  const uniqueTypes = unique(types);
  const density = uniqueTypes.length / Math.max(3, safeArray(signals).length * 1.5);
  return Number(Math.min(1, density).toFixed(3));
}

function questionContinuity(signals = []) {
  const questions = safeArray(signals).flatMap((signal) => safeArray(signal.questions));
  if (!questions.length) return 0;
  return Number(Math.min(1, questions.length / Math.max(2, safeArray(signals).length)).toFixed(3));
}

export function measureContinuity(signals = []) {
  const safeSignals = safeArray(signals).filter((signal) => signal?.memory_id);
  if (!safeSignals.length) {
    return { score: 0, dimensions: {}, reasons: [] };
  }

  const allCharacters = unique(safeSignals.flatMap((signal) => signal.characters));
  const allContexts = unique(safeSignals.flatMap((signal) => signal.contexts));
  const allKeywords = unique(safeSignals.flatMap((signal) => signal.keywords));
  const allSignalTypes = unique(safeSignals.flatMap((signal) => signal.signal_types));
  const allQuestions = unique(safeSignals.flatMap((signal) => signal.questions));

  const characterDensity = Math.min(1, allCharacters.length ? safeSignals.filter((s) => s.characters?.length).length / safeSignals.length : 0);
  const contextDensity = Math.min(1, allContexts.length ? safeSignals.filter((s) => s.contexts?.length).length / safeSignals.length : 0);
  const keywordDensity = Math.min(1, allKeywords.length / Math.max(8, safeSignals.length * 4));
  const temporal = temporalContinuityScore(safeSignals);
  const transformation = Math.min(1, safeSignals.reduce((sum, s) => sum + Number(s.transformation_count || 0), 0) / Math.max(2, safeSignals.length));
  const consequence = Math.min(1, safeSignals.reduce((sum, s) => sum + Number(s.consequence_count || 0), 0) / Math.max(2, safeSignals.length));
  const emotion = Math.min(1, safeSignals.reduce((sum, s) => sum + Number(s.emotional_count || 0), 0) / Math.max(2, safeSignals.length));
  const narrativeSignals = signalTypeContinuity(safeSignals);
  const questions = questionContinuity(safeSignals);
  const density = Math.min(1, safeSignals.reduce((sum, s) => sum + Number(s.narrative_density || 0), 0) / Math.max(100, safeSignals.length * 100));

  const dimensions = {
    characters: Number(characterDensity.toFixed(3)),
    temporal: Number(temporal.toFixed(3)),
    context: Number(((contextDensity * 0.72) + (keywordDensity * 0.28)).toFixed(3)),
    transformation: Number(transformation.toFixed(3)),
    consequence: Number(consequence.toFixed(3)),
    emotional: Number(emotion.toFixed(3)),
    narrativeSignals: Number(narrativeSignals.toFixed(3)),
    questions: Number(questions.toFixed(3)),
    narrativeDensity: Number(density.toFixed(3)),
  };

  const score = Number((
    dimensions.characters * 0.18 +
    dimensions.temporal * 0.14 +
    dimensions.context * 0.12 +
    dimensions.transformation * 0.12 +
    dimensions.consequence * 0.09 +
    dimensions.emotional * 0.08 +
    dimensions.narrativeSignals * 0.15 +
    dimensions.questions * 0.05 +
    dimensions.narrativeDensity * 0.07
  ).toFixed(3));

  const reasons = [];
  if (allCharacters.length) reasons.push(`personagens recorrentes: ${allCharacters.slice(0, 4).join(", ")}`);
  if (allContexts.length) reasons.push(`contextos recorrentes: ${allContexts.slice(0, 4).join(", ")}`);
  if (allSignalTypes.length) reasons.push(`sinais narrativos: ${allSignalTypes.slice(0, 5).join(", ")}`);
  if (allQuestions.length) reasons.push(`perguntas humanas possíveis: ${allQuestions.slice(0, 3).join(" | ")}`);
  if (dimensions.temporal >= 0.65) reasons.push("continuidade temporal perceptível");
  if (dimensions.transformation >= 0.35) reasons.push("sinais de transformação pessoal");
  if (dimensions.consequence >= 0.25) reasons.push("sinais de consequência narrativa");
  if (dimensions.emotional >= 0.35) reasons.push("continuidade emocional");
  if (dimensions.narrativeSignals >= 0.45) reasons.push("densidade de sinais narrativos");

  return {
    score,
    dimensions,
    reasons,
    characters: allCharacters,
    contexts: allContexts,
    keywords: allKeywords.slice(0, 12),
    signal_types: allSignalTypes,
    questions: allQuestions.slice(0, 8),
  };
}

export function signalAffinityScore(left, right) {
  if (!left || !right) return 0;

  const character = overlapScore(left.characters, right.characters);
  const context = overlapScore(left.contexts, right.contexts);
  const keyword = overlapScore(left.keywords, right.keywords);
  const signalType = overlapScore(left.signal_types, right.signal_types);
  const question = overlapScore(left.questions, right.questions);
  const emotional = left.emotional_count && right.emotional_count ? 1 : 0;
  const transformation = left.transformation_count && right.transformation_count ? 1 : 0;
  const consequence = left.consequence_count && right.consequence_count ? 1 : 0;

  return Number((
    character * 0.24 +
    context * 0.17 +
    keyword * 0.12 +
    signalType * 0.23 +
    question * 0.08 +
    emotional * 0.06 +
    transformation * 0.06 +
    consequence * 0.04
  ).toFixed(3));
}

export const StoryContinuityService = {
  compareMemoryDate,
  extractNarrativeSignals,
  measureContinuity,
  memoryCanonicalDate,
  memoryIdOf,
  memoryText,
  normalizeKey,
  safeDate,
  safeYear,
  signalAffinityScore,
};
