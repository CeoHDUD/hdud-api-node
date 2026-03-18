// C:\HDUD_DATA\hdud-api-node\src\services\chapters\chapter-ai.service.js

import { getPool, sql } from "../../db.js";

function normalizeText(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function safeIso(value) {
  try {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return new Date().toISOString();
}

function compactSpaces(text) {
  return normalizeText(text, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;:!?])\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyIsoDateToken(token) {
  return /^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:\d{2})?)?$/i.test(token);
}

function isLikelyDateToken(token) {
  return (
    /^\d{8}$/.test(token) ||
    /^\d{6}$/.test(token) ||
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(token) ||
    /^\d{4}-\d{2}-\d{2}$/.test(token) ||
    /^\d{2}\/\d{2}\/\d{4}$/.test(token) ||
    /^\d{2}-\d{2}-\d{4}$/.test(token) ||
    /^\d{2}[tT]\d{2}$/.test(token) ||
    isLikelyIsoDateToken(token)
  );
}

function isMostlyNumericToken(token) {
  if (!token) return false;
  const clean = String(token).replace(/[^\d]/g, "");
  return clean.length >= 4 && clean.length >= Math.max(4, Math.floor(String(token).length * 0.6));
}

function isTechnicalNoiseToken(token) {
  const t = String(token || "").toLowerCase().trim();
  if (!t) return true;

  return (
    t === "smoke" ||
    t === "test" ||
    t === "tests" ||
    t === "memory" ||
    t === "chapter" ||
    t === "chapters" ||
    t === "debug" ||
    t === "tmp" ||
    t === "temp" ||
    t === "null" ||
    t === "undefined" ||
    t === "json" ||
    t === "api" ||
    t === "route" ||
    t === "routes" ||
    t === "endpoint" ||
    t === "endpoints" ||
    t === "post" ||
    t === "get" ||
    t === "put" ||
    t === "delete" ||
    t === "localhost" ||
    /^hdud[_\-]?\d+/i.test(t) ||
    /^smoke[_\-]?\d*/i.test(t) ||
    /^memory[_\-]?\d*/i.test(t) ||
    /^chapter[_\-]?\d*/i.test(t)
  );
}

function sanitizeNarrativeText(text) {
  let s = normalizeText(text, "");

  if (!s) return "";

  s = s
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:\d{2})\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{8,14}\b/g, " ")
    .replace(/\b\d{2}[tT]\d{2}\b/g, " ")
    .replace(/[|_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,;:!?()\-]/gu, " ")
    .replace(/\s+/g, " ");

  const tokens = s
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((token) => !isLikelyDateToken(token))
    .filter((token) => !isMostlyNumericToken(token))
    .filter((token) => !isTechnicalNoiseToken(token));

  s = tokens.join(" ");
  s = compactSpaces(s);

  if (!s) return "";

  s = s.replace(/\b([a-zà-ÿ])(?=[a-zà-ÿ]+)/giu, (m, c, offset) => {
    if (offset === 0) return c.toUpperCase();
    return c;
  });

  if (!/[.!?]$/.test(s)) s += ".";
  return s;
}

function previewText(text, maxLen = 220) {
  const s = compactSpaces(sanitizeNarrativeText(text));
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen - 1).trim() + "…" : s;
}

function splitWords(text) {
  return sanitizeNarrativeText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const STOPWORDS_PT = new Set([
  "a",
  "o",
  "e",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "em",
  "no",
  "na",
  "nos",
  "nas",
  "um",
  "uma",
  "uns",
  "umas",
  "para",
  "por",
  "com",
  "sem",
  "sobre",
  "que",
  "se",
  "eu",
  "meu",
  "minha",
  "meus",
  "minhas",
  "ele",
  "ela",
  "eles",
  "elas",
  "foi",
  "era",
  "ser",
  "estar",
  "ter",
  "ha",
  "havia",
  "como",
  "mais",
  "menos",
  "muito",
  "muita",
  "muitos",
  "muitas",
  "ja",
  "ainda",
  "tambem",
  "depois",
  "antes",
  "quando",
  "onde",
  "porque",
  "pra",
  "pro",
  "num",
  "numa",
  "ao",
  "aos",
  "ate",
  "entre",
  "isso",
  "isto",
  "aquele",
  "aquela",
  "aquilo",
  "mas",
  "ou",
  "nem",
  "seu",
  "sua",
  "seus",
  "suas",
  "nossa",
  "nosso",
  "nossos",
  "nossas",
  "vida",
  "hdud",
  "memory",
  "memoria",
  "memorias",
  "capitulo",
  "capitulos",
  "smoke",
  "test",
  "tests",
  "chapter",
  "chapters",
  "coisa",
  "coisas",
  "parte",
  "momento",
  "momentos",
  "dia",
  "dias",
  "ano",
  "anos",
  "fase",
  "fases",
]);

const STRONG_THEME_BOOST = new Map([
  ["mvp", 6],
  ["projeto", 5],
  ["evolucao", 5],
  ["evolução", 5],
  ["avanço", 5],
  ["avanco", 5],
  ["avançando", 5],
  ["avancando", 5],
  ["construcao", 4],
  ["construção", 4],
  ["desenvolvimento", 5],
  ["validacao", 4],
  ["validação", 4],
  ["ajustes", 3],
  ["progresso", 5],
  ["entrega", 4],
  ["implementacao", 4],
  ["implementação", 4],
  ["produto", 4],
  ["sistema", 3],
  ["motor", 4],
  ["timeline", 3],
  ["capitulo", 3],
  ["capítulo", 3],
]);

function normalizeThemeKey(word) {
  return String(word || "")
    .toLowerCase()
    .trim();
}

function isNarrativeCandidate(word) {
  const w = normalizeThemeKey(word);
  if (!w) return false;
  if (w.length < 4) return false;
  if (STOPWORDS_PT.has(w)) return false;
  if (isLikelyDateToken(w)) return false;
  if (isMostlyNumericToken(w)) return false;
  if (isTechnicalNoiseToken(w)) return false;
  if (/^\d+$/.test(w)) return false;
  return true;
}

function extractThemes(memories, maxThemes = 5) {
  const freq = new Map();

  for (const m of memories) {
    const words = splitWords(`${m.title || ""} ${m.content || ""}`);
    for (const w of words) {
      if (!isNarrativeCandidate(w)) continue;
      const boost = STRONG_THEME_BOOST.get(normalizeThemeKey(w)) || 1;
      freq.set(w, (freq.get(w) || 0) + boost);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))
    .slice(0, maxThemes)
    .map(([word]) => {
      const low = String(word).toLowerCase();
      if (low === "mvp") return "MVP";
      if (low === "hdud") return "HDUD";
      return word;
    });
}

function isArtificialTitle(title) {
  const t = normalizeText(title, "");
  if (!t) return true;

  const normalized = t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  if (/^smoke/i.test(normalized)) return true;
  if (/^hdud[_\-\s]?\d+/i.test(normalized)) return true;
  if (/^memory[_\-\s]?\d*/i.test(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  if (normalized.split(/\s+/).every((x) => isLikelyDateToken(x) || isMostlyNumericToken(x))) return true;

  return false;
}

function sanitizeTitleCandidate(title) {
  const s = sanitizeNarrativeText(title)
    .replace(/\bsmoke\b/gi, "")
    .replace(/\bmemory\b/gi, "")
    .replace(/\bhdud\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";
  return s.length > 120 ? s.slice(0, 120).trim() : s;
}

function capitalizePhrase(text) {
  const s = compactSpaces(text);
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildTitleSuggestion(memories, themes) {
  const strongHumanTitles = memories
    .map((m) => sanitizeTitleCandidate(m.title))
    .filter(Boolean)
    .filter((t) => !isArtificialTitle(t))
    .filter((t) => t.length >= 6);

  if (strongHumanTitles.length) {
    return strongHumanTitles[0];
  }

  const theme1 = normalizeText(themes?.[0], "");
  const theme2 = normalizeText(themes?.[1], "");
  const theme3 = normalizeText(themes?.[2], "");

  const low1 = theme1.toLowerCase();
  const low2 = theme2.toLowerCase();
  const low3 = theme3.toLowerCase();

  if (
    ["mvp", "projeto", "desenvolvimento", "evolução", "evolucao", "progresso"].includes(low1) ||
    ["mvp", "projeto", "desenvolvimento", "evolução", "evolucao", "progresso"].includes(low2)
  ) {
    return "Entre testes e avanço do projeto";
  }

  if (theme1 && theme2) {
    return capitalizePhrase(`Entre ${theme1.toLowerCase()} e ${theme2.toLowerCase()}`);
  }

  if (theme1 && theme3) {
    return capitalizePhrase(`${theme1} em fase de construção`);
  }

  if (theme1) {
    return capitalizePhrase(`Um capítulo sobre ${theme1.toLowerCase()}`);
  }

  return "Síntese de memórias vinculadas";
}

function deriveSectionFromContent(content) {
  const low = normalizeText(content, "").toLowerCase();

  if (low.includes("finalizando") && low.includes("mvp")) {
    return "Finalizando o MVP";
  }

  if (
    low.includes("avançando") ||
    low.includes("avancando") ||
    low.includes("progresso") ||
    low.includes("evolução") ||
    low.includes("evolucao")
  ) {
    return "Avanços concretos no projeto";
  }

  if (low.includes("teste") || low.includes("validação") || low.includes("validacao")) {
    return "Os primeiros testes do motor";
  }

  const snippet = previewText(content, 70);
  if (!snippet) return "";

  let s = snippet.replace(/[.]+$/, "").trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

function buildSections(memories, maxSections = 6) {
  const sections = [];

  for (const m of memories) {
    const title = sanitizeTitleCandidate(m.title);
    const content = sanitizeNarrativeText(m.content);

    if (title && !isArtificialTitle(title) && title.length >= 6) {
      sections.push(title);
      continue;
    }

    const derived = deriveSectionFromContent(content);
    if (derived) sections.push(derived);
  }

  const unique = [];
  const seen = new Set();

  for (const s of sections) {
    const key = String(s).toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
    if (unique.length >= maxSections) break;
  }

  return unique.length
    ? unique
    : ["Abertura do capítulo", "Desenvolvimento narrativo", "Fechamento"];
}

function buildSummary(memories, themes) {
  const count = memories.length;
  const rawTexts = memories
    .map((m) => sanitizeNarrativeText(m.content))
    .filter(Boolean);

  const joined = rawTexts.join(" ").toLowerCase();

  const hasMvp = /\bmvp\b/i.test(joined);
  const hasAdvance = /avanç|avanc|progresso|evolu|desenvolv/i.test(joined);
  const hasTest = /teste|valida|ajuste/i.test(joined);

  const intro =
    count === 1
      ? "Este capítulo reúne uma memória central de um mesmo momento narrativo."
      : `Este capítulo reúne ${count} memórias de uma mesma fase da trajetória do autor.`;

  if (hasMvp && hasAdvance && hasTest) {
    return (
      `${intro} ` +
      "A síntese aponta para um período de construção intensa, marcado por testes, ajustes e sensação concreta de progresso no desenvolvimento do MVP."
    );
  }

  if (hasAdvance && hasTest) {
    return (
      `${intro} ` +
      "A leitura conjunta sugere um arco de evolução prática, com validações, refinamentos e percepção clara de avanço no projeto."
    );
  }

  if (themes && themes.length) {
    return (
      `${intro} ` +
      `Os temas centrais deste conjunto giram em torno de ${themes.slice(0, 3).join(", ")}, formando um capítulo com potencial autobiográfico consistente.`
    );
  }

  const previews = rawTexts.map((x) => previewText(x, 120)).filter(Boolean).slice(0, 2);
  if (previews.length) {
    return `${intro} Em síntese, ${previews.join(" ")}`;
  }

  return (
    `${intro} ` +
    "Há material suficiente para estruturar um capítulo autobiográfico com começo, desenvolvimento e fechamento."
  );
}

function buildEmotionalArc(memories) {
  const texts = memories.map((m) => sanitizeNarrativeText(m.content).toLowerCase()).join(" ");

  const positiveHints = [
    "conquista",
    "vitória",
    "vitoria",
    "feliz",
    "orgulho",
    "alegria",
    "avançando",
    "avancando",
    "avancei",
    "finalizando",
    "progresso",
    "evolução",
    "evolucao",
  ];

  const tensionHints = [
    "dificil",
    "difícil",
    "medo",
    "dor",
    "perda",
    "crise",
    "problema",
    "pressão",
    "pressao",
    "desafio",
    "desafios",
  ];

  const nostalgiaHints = [
    "infância",
    "infancia",
    "pai",
    "mãe",
    "mae",
    "família",
    "familia",
    "lembrança",
    "lembranca",
  ];

  const hasPositive = positiveHints.some((x) => texts.includes(x));
  const hasTension = tensionHints.some((x) => texts.includes(x));
  const hasNostalgia = nostalgiaHints.some((x) => texts.includes(x));

  const arc = [];
  if (hasNostalgia) arc.push("nostalgia");
  if (hasTension) arc.push("tensão");
  if (hasPositive) arc.push("superação");

  return arc.length ? arc : ["reflexão"];
}

function buildSnapshot(memories) {
  return {
    memory_ids: memories
      .map((m) => Number(m.memory_id))
      .filter((x) => Number.isInteger(x) && x > 0),
    memory_count: memories.length,
    ordered_by: "created_at,memory_id",
    source: "dbo.p_GetChapterMemoriesForAI",
    generated_at: new Date().toISOString(),
    range: {
      from: memories[0]?.created_at ? safeIso(memories[0].created_at) : null,
      to:
        memories[memories.length - 1]?.created_at
          ? safeIso(memories[memories.length - 1].created_at)
          : null,
    },
  };
}

function buildMockSuggestion({ chapterId, authorId, memories, options = {} }) {
  const themes = extractThemes(memories, Math.min(Number(options.maxThemes) || 5, 8));
  const sections = buildSections(memories, Math.min(Number(options.maxSections) || 6, 8));
  const title = buildTitleSuggestion(memories, themes);
  const summary = buildSummary(memories, themes);
  const emotionalArc = buildEmotionalArc(memories);

  const snapshot = buildSnapshot(memories);

  const payload = {
    chapter_id: chapterId,
    author_id: authorId,
    source_memory_count: memories.length,
    source_snapshot_json: JSON.stringify(snapshot),
    llm_provider: "mock",
    llm_model: "chapter-engine-v2-editorial-local",
    prompt_version: "chapter-engine-v2-editorial",
    chapter_title_suggestion: title,
    chapter_summary: summary,
    themes,
    sections,
    emotional_arc: emotionalArc,
    confidence_score: memories.length >= 3 ? 0.88 : 0.76,
    tokens_input: null,
    tokens_output: null,
    raw_response_json: JSON.stringify({
      provider: "mock",
      generated_at: new Date().toISOString(),
      options,
      corpus_preview: memories.map((m) => ({
        memory_id: m.memory_id,
        title: sanitizeTitleCandidate(m.title),
        preview: previewText(m.content, 120),
      })),
    }),
  };

  return payload;
}

async function assertChapterOwned(pool, authorId, chapterId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 chapter_id
      FROM dbo.identity_chapter
      WHERE chapter_id = @chapter_id
        AND author_id  = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return !!r.recordset?.[0]?.chapter_id;
}

async function fetchChapterCorpus(pool, chapterId) {
  const result = await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .execute("dbo.p_GetChapterMemoriesForAI");

  return result?.recordset || [];
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildEmptySuggestionResponse(chapterId) {
  return {
    ok: true,
    status: 200,
    code: "NO_SUGGESTION_YET",
    message: "Nenhuma sugestão foi gerada para este capítulo ainda.",
    chapter_id: Number(chapterId),
    suggestion_id: null,
    data: {
      chapter_title_suggestion: null,
      chapter_summary: null,
      themes: [],
      sections: [],
      emotional_arc: [],
      confidence_score: null,
    },
    meta: {
      suggestion_status: null,
      source_memory_count: null,
      source_snapshot: null,
      provider: null,
      model: null,
      prompt_version: null,
      tokens_input: null,
      tokens_output: null,
      created_at: null,
      applied_at: null,
      discarded_at: null,
    },
  };
}

export async function generateChapterSuggestion({
  authorId,
  chapterId,
  options = {},
}) {
  const pool = await getPool();

  const chapterOwned = await assertChapterOwned(pool, authorId, chapterId);
  if (!chapterOwned) {
    return {
      ok: false,
      status: 404,
      code: "CHAPTER_NOT_FOUND",
      message: "Capítulo não encontrado.",
    };
  }

  const memories = await fetchChapterCorpus(pool, chapterId);

  const validMemories = memories.filter((m) => {
    const content = normalizeText(m.content, "");
    const title = normalizeText(m.title, "");
    return content.length > 0 || title.length > 0;
  });

  if (validMemories.length < 2) {
    return {
      ok: false,
      status: 422,
      code: "INSUFFICIENT_CHAPTER_CONTEXT",
      message:
        "O capítulo precisa de pelo menos 2 memórias com conteúdo suficiente para gerar uma sugestão consistente.",
      meta: {
        memory_count: validMemories.length,
      },
    };
  }

  const suggestion = buildMockSuggestion({
    chapterId,
    authorId,
    memories: validMemories,
    options,
  });

  const save = await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .input("author_id", sql.Int, authorId)
    .input("source_memory_count", sql.Int, suggestion.source_memory_count)
    .input("source_snapshot_json", sql.NVarChar(sql.MAX), suggestion.source_snapshot_json)
    .input("llm_provider", sql.VarChar(50), suggestion.llm_provider)
    .input("llm_model", sql.VarChar(100), suggestion.llm_model)
    .input("prompt_version", sql.VarChar(30), suggestion.prompt_version)
    .input(
      "chapter_title_suggestion",
      sql.NVarChar(500),
      suggestion.chapter_title_suggestion
    )
    .input("chapter_summary", sql.NVarChar(sql.MAX), suggestion.chapter_summary)
    .input("themes_json", sql.NVarChar(sql.MAX), JSON.stringify(suggestion.themes || []))
    .input("sections_json", sql.NVarChar(sql.MAX), JSON.stringify(suggestion.sections || []))
    .input(
      "emotional_arc_json",
      sql.NVarChar(sql.MAX),
      JSON.stringify(suggestion.emotional_arc || [])
    )
    .input("confidence_score", sql.Decimal(5, 2), Number(suggestion.confidence_score || 0))
    .input("tokens_input", sql.Int, suggestion.tokens_input)
    .input("tokens_output", sql.Int, suggestion.tokens_output)
    .input("raw_response_json", sql.NVarChar(sql.MAX), suggestion.raw_response_json)
    .execute("dbo.p_CreateChapterAISuggestion");

  const suggestionId = Number(save?.recordset?.[0]?.suggestion_id ?? 0) || null;

  return {
    ok: true,
    status: 201,
    chapter_id: chapterId,
    suggestion_id: suggestionId,
    data: {
      chapter_title_suggestion: suggestion.chapter_title_suggestion,
      chapter_summary: suggestion.chapter_summary,
      themes: suggestion.themes,
      sections: suggestion.sections,
      emotional_arc: suggestion.emotional_arc,
      confidence_score: suggestion.confidence_score,
    },
    meta: {
      provider: suggestion.llm_provider,
      model: suggestion.llm_model,
      prompt_version: suggestion.prompt_version,
      source_memory_count: suggestion.source_memory_count,
      source_snapshot: parseJsonField(suggestion.source_snapshot_json, null),
      generated_at: new Date().toISOString(),
    },
  };
}

export async function getLatestChapterSuggestion({ authorId, chapterId }) {
  const pool = await getPool();

  const chapterOwned = await assertChapterOwned(pool, authorId, chapterId);
  if (!chapterOwned) {
    return {
      ok: false,
      status: 404,
      code: "CHAPTER_NOT_FOUND",
      message: "Capítulo não encontrado.",
    };
  }

  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        suggestion_id,
        chapter_id,
        author_id,
        source_memory_count,
        source_snapshot_json,
        llm_provider,
        llm_model,
        prompt_version,
        suggestion_status,
        chapter_title_suggestion,
        chapter_summary,
        themes_json,
        sections_json,
        emotional_arc_json,
        confidence_score,
        tokens_input,
        tokens_output,
        raw_response_json,
        created_at,
        applied_at,
        discarded_at
      FROM dbo.identity_chapter_ai_suggestion
      WHERE chapter_id = @chapter_id
        AND author_id  = @author_id
      ORDER BY suggestion_id DESC;
    `);

  const row = r?.recordset?.[0];
  if (!row) {
    return buildEmptySuggestionResponse(chapterId);
  }

  return {
    ok: true,
    status: 200,
    chapter_id: Number(row.chapter_id),
    suggestion_id: Number(row.suggestion_id),
    data: {
      chapter_title_suggestion:
        row.chapter_title_suggestion != null ? String(row.chapter_title_suggestion) : null,
      chapter_summary: row.chapter_summary != null ? String(row.chapter_summary) : null,
      themes: parseJsonField(row.themes_json, []),
      sections: parseJsonField(row.sections_json, []),
      emotional_arc: parseJsonField(row.emotional_arc_json, []),
      confidence_score:
        row.confidence_score != null ? Number(row.confidence_score) : null,
    },
    meta: {
      suggestion_status:
        row.suggestion_status != null ? String(row.suggestion_status) : null,
      source_memory_count:
        row.source_memory_count != null ? Number(row.source_memory_count) : null,
      source_snapshot: parseJsonField(row.source_snapshot_json, null),
      provider: row.llm_provider != null ? String(row.llm_provider) : null,
      model: row.llm_model != null ? String(row.llm_model) : null,
      prompt_version: row.prompt_version != null ? String(row.prompt_version) : null,
      tokens_input: row.tokens_input != null ? Number(row.tokens_input) : null,
      tokens_output: row.tokens_output != null ? Number(row.tokens_output) : null,
      created_at: row.created_at ?? null,
      applied_at: row.applied_at ?? null,
      discarded_at: row.discarded_at ?? null,
    },
  };
}