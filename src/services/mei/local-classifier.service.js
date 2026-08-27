// HDUD — MEI Local Classification Engine V2
// Pure/deterministic: no DB, no network, no external AI.

export const MEI_LOCAL_ENGINE_VERSION = "MEI_LOCAL_V2_FINAL";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryText(memory) {
  return normalizeText(`${memory?.title || ""} ${memory?.content || ""}`);
}

function has(text, phrase) {
  const p = normalizeText(phrase);
  return !!p && ` ${text} `.includes(` ${p} `);
}

function any(text, phrases) {
  return phrases.some((p) => has(text, p));
}

function candidate(code, score, evidence) {
  return { code, score, evidence };
}

function best(candidates, threshold) {
  const valid = candidates
    .filter((x) => x && x.code && Number(x.score) >= threshold)
    .sort((a, b) => b.score - a.score);
  return valid[0] || { code: null, score: 0, evidence: null };
}

function lifePeriodCandidates(text) {
  const c = [];
  if (any(text, ["quando eu nasci", "meu nascimento", "eu nasci"])) c.push(candidate("BIRTH", 0.96, "birth_explicit"));
  if (any(text, ["primeira infancia", "quando eu era bebe", "quando era bebe", "no berco", "na creche"])) c.push(candidate("EARLY_CHILDHOOD", 0.92, "early_childhood_explicit"));
  if (any(text, ["minha infancia", "na infancia", "quando eu era crianca", "quando era crianca", "quando eu era menino", "quando eu era menina"])) c.push(candidate("CHILDHOOD", 0.94, "childhood_explicit"));
  if (any(text, ["minha adolescencia", "na adolescencia", "quando eu era adolescente"])) c.push(candidate("ADOLESCENCE", 0.94, "adolescence_explicit"));
  if (any(text, ["minha juventude", "na juventude", "quando eu era jovem"])) c.push(candidate("YOUTH", 0.90, "youth_explicit"));
  if (any(text, ["inicio da vida adulta", "quando eu era jovem adulto", "quando eu era jovem adulta"])) c.push(candidate("YOUNG_ADULT", 0.91, "young_adult_explicit"));
  if (any(text, ["na vida adulta", "quando eu era adulto", "quando eu era adulta"])) c.push(candidate("ADULT_LIFE", 0.90, "adult_life_explicit"));
  if (any(text, ["na maturidade", "meia idade"])) c.push(candidate("MATURITY", 0.88, "maturity_explicit"));
  if (any(text, ["na velhice", "terceira idade", "quando eu era idoso", "quando eu era idosa"])) c.push(candidate("LATER_LIFE", 0.90, "later_life_explicit"));
  return c;
}

function contextCandidates(text) {
  const c = [];

  const mother = any(text, ["minha mae", "mama", "mamae"]);
  const father = any(text, ["meu pai", "papai"]);
  const parentChild = any(text, ["meu filho", "minha filha", "meu menino", "minha menina"]);
  const family = mother || father || parentChild || any(text, ["meus pais", "minha familia", "meus filhos", "minhas filhas", "irmao", "irma", "avos", "avó", "avô"]);
  const affection = any(text, ["grato", "gratidao", "carinho", "afeto", "presente", "ao meu lado", "cuidou", "cuidado", "amor", "orgulho"]);

  if (parentChild && affection) c.push(candidate("PARENT_CHILD_BOND", 0.94, "parent_child_affection"));
  if (parentChild) c.push(candidate("PARENT_CHILD_BOND", 0.90, "parent_child"));
  if (family && affection) c.push(candidate("FAMILY_AFFECTION", 0.90, "family_affection"));
  if (family) c.push(candidate("FAMILY", 0.84, "family"));

  if (any(text, ["bruna", "minha esposa", "meu marido", "namoro", "namoramos", "casamento", "relacionamento amoroso"])) c.push(candidate("LOVE", 0.89, "love_relationship"));
  if (any(text, ["hdud", "historias de um desconhecido", "plataforma hdud"])) c.push(candidate("HDUD", 0.96, "hdud"));
  const healthStrong = any(text, ["hospital", "cirurgia", "internacao", "saude", "coluna", "l5", "diagnostico", "reabilitacao", "medico", "medica"]);
  const healthTreatment = has(text, "tratamento") && any(text, ["saude", "hospital", "diagnostico", "medico", "medica", "cirurgia", "doenca", "dor", "reabilitacao"]);
  if (healthStrong || healthTreatment) c.push(candidate("HEALTH", 0.93, "health"));
  if (any(text, ["sql server", "dba", "trabalho", "empresa", "emprego", "profissao", "carreira", "projeto profissional"])) c.push(candidate("WORK", 0.89, "work"));
  if (any(text, ["escola", "colegio", "faculdade", "universidade", "professor", "curso", "estudo", "formacao"])) c.push(candidate("EDUCATION", 0.89, "education"));
  if (any(text, ["futebol", "cbf", "jogo", "time", "campeonato"])) c.push(candidate("SPORT", 0.90, "sport"));
  if (any(text, ["viagem", "viajei", "hotel", "aviao", "ferias"])) c.push(candidate("TRAVEL", 0.86, "travel"));
  if (any(text, ["luto", "morreu", "morte", "despedida", "perda de"])) c.push(candidate("LOSS", 0.91, "loss"));
  if (any(text, ["identidade", "quem eu fui", "quem sou", "autoconhecimento"])) c.push(candidate("IDENTITY", 0.89, "identity"));
  if (any(text, ["proposito", "missao de vida", "sentido da vida"])) c.push(candidate("PURPOSE", 0.89, "purpose"));
  if (any(text, ["conquista", "vitoria", "aprovacao", "certificacao", "premio"])) c.push(candidate("ACHIEVEMENT", 0.87, "achievement"));

  // Childhood is a valid context too, but only as fallback when no more specific life-domain signal exists.
  if (any(text, ["minha infancia", "na infancia", "quando eu era crianca", "quando era crianca"])) c.push(candidate("CHILDHOOD", 0.82, "childhood_context"));

  return c;
}

function roleCandidates(text, contextCode) {
  const c = [];
  if (any(text, ["primeira vez", "onde tudo comecou", "como tudo comecou", "origem"])) c.push(candidate("ORIGIN", 0.91, "origin"));
  if (any(text, ["decidi", "decisao", "escolhi", "resolvi"])) c.push(candidate("DECISION", 0.92, "decision"));
  if (any(text, ["descobri", "percebi", "entendi", "me dei conta"])) c.push(candidate("DISCOVERY", 0.90, "discovery"));
  if (any(text, ["dificuldade", "obstaculo", "barreira"])) c.push(candidate("OBSTACLE", 0.88, "obstacle"));
  if (any(text, ["briga", "conflito", "tensao", "disputa"])) c.push(candidate("CONFLICT", 0.90, "conflict"));
  if (any(text, ["crise", "internacao", "cirurgia", "hospital"])) c.push(candidate("CRISIS", 0.91, "crisis"));
  if (any(text, ["mudou minha vida", "transformou", "ponto de virada", "renasci"])) c.push(candidate("TRANSFORMATION", 0.93, "transformation"));
  if (any(text, ["aprendi", "licao", "ensinou", "aprendizado"])) c.push(candidate("LEARNING", 0.90, "learning"));
  if (any(text, ["legado", "ser lembrado", "ser lembrada", "preservar minha historia"])) c.push(candidate("LEGACY", 0.91, "legacy"));
  if (any(text, ["prova", "evidencia", "registro", "documento", "fotografia"])) c.push(candidate("EVIDENCE", 0.87, "evidence"));
  if (any(text, ["grato", "gratidao", "refletindo", "olhando para tras"])) c.push(candidate("REFLECTION", 0.86, "reflection"));

  // Context-derived roles are deliberately lower confidence than explicit narrative signals.
  if (contextCode === "FAMILY_AFFECTION" || contextCode === "PARENT_CHILD_BOND") c.push(candidate("REFLECTION", 0.80, "context_fallback"));
  if (["FAMILY", "LOVE", "WORK", "EDUCATION", "CHILDHOOD"].includes(contextCode)) c.push(candidate("CONTEXT", 0.76, "context_fallback"));
  if (contextCode === "HDUD") c.push(candidate("DISCOVERY", 0.96, "hdud_discovery_context"));
  if (contextCode === "HEALTH") c.push(candidate("CRISIS", 0.76, "context_fallback"));

  return c;
}

function confidenceFromSignals(signals) {
  const scores = signals.filter((x) => x?.code).map((x) => Number(x.score)).filter(Number.isFinite);
  if (!scores.length) return 0.35;
  return Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4));
}

function certainty(confidence) {
  if (confidence >= 0.88) return "HIGH";
  if (confidence >= 0.68) return "MEDIUM";
  return "LOW";
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function classifyLocalMemoryV2(memory, reason = "Classificação editorial automática local da HDUD — sem consumo de IA externa.") {
  const text = memoryText(memory);
  const life = best(lifePeriodCandidates(text), 0.84);
  const context = best(contextCandidates(text), 0.82);
  const role = best(roleCandidates(text, context.code), 0.74);
  const confidence = confidenceFromSignals([life, context, role]);
  const size = String(memory?.content || "").length;

  const historical = any(text, ["eu nasci", "meu nascimento", "casamento", "cirurgia", "hospital", "morte", "mudou minha vida"]) ? 5 : size > 1800 ? 4 : 3;
  const narrative = role.code && role.code !== "CONTEXT" ? 4 : size > 1000 ? 3 : 2;
  const emotional = any(text, ["chorei", "dor", "amor", "medo", "feliz", "hospital", "meu filho", "minha filha", "bruna", "morte", "saudade"]) ? 5 : 3;

  let valence = 0;
  if (any(text, ["amor", "feliz", "alegria", "conquista", "casamento", "gratidao", "grato"])) valence += 1;
  if (any(text, ["dor", "hospital", "cirurgia", "morte", "perda", "medo", "crise"])) valence -= 1;

  return {
    life_period_code: life.code,
    context_code: context.code,
    narrative_role_code: role.code,
    narrative_arc_code: null,
    canonical_story_key: null,
    canonical_story_title: null,
    historical_importance: clampInt(historical, 1, 5, 3),
    narrative_importance: clampInt(narrative, 1, 5, 2),
    emotional_intensity: clampInt(emotional, 1, 5, 3),
    emotional_valence: clampInt(valence, -2, 2, 0),
    editorial_notes: String(reason || "").trim() || "Classificação editorial automática local da HDUD — sem consumo de IA externa.",
    ai_confidence: confidence,
    editorial_certainty: certainty(confidence),
    interpretation_source: "AI_LOCAL",
    classified_by: "HDUD_LOCAL",
    classification_version: MEI_LOCAL_ENGINE_VERSION,
    _signals: {
      life_period: life,
      context,
      narrative_role: role,
    },
  };
}
