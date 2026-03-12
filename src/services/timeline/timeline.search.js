// C:\HDUD_DATA\hdud-api-node\src\services\timeline\timeline.search.js

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function normalizeTimelineType(input) {
  const raw = String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) return "all";

  if (
    raw === "memory" ||
    raw === "memories" ||
    raw === "memoria" ||
    raw === "memorias"
  ) {
    return "memory";
  }

  if (
    raw === "chapter" ||
    raw === "chapters" ||
    raw === "capitulo" ||
    raw === "capitulos"
  ) {
    return "chapter";
  }

  return "all";
}

export function normalizeTimelineQuery(input, maxLen = 160) {
  const s = String(input || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";
  return s.slice(0, maxLen);
}

export function normalizeTimelineParams(query) {
  return {
    limit: clampInt(query?.limit, 1, 500, 100),
    type: normalizeTimelineType(query?.type),
    q: normalizeTimelineQuery(query?.q),
  };
}

export function buildTimelineWarnings({
  q,
  narrativeTableExists,
  narrativeRowsCount,
  fallbackActive,
  resultCount,
  limit,
}) {
  const warnings = [];

  if (!narrativeTableExists) {
    warnings.push(
      "identity_narrative_event não encontrada. Timeline operando em modo fallback real (memórias + capítulos)."
    );
  } else if (narrativeRowsCount === 0 && fallbackActive) {
    warnings.push(
      "Nenhum evento narrativo materializado encontrado para este autor. Timeline complementada com acervo real."
    );
  }

  if (q && resultCount === 0) {
    warnings.push(`Nenhum resultado encontrado para "${q}".`);
  }

  if (resultCount >= limit) {
    warnings.push(
      `Resultado limitado a ${limit} item(ns). Ajuste o parâmetro limit se precisar ampliar a janela visível.`
    );
  }

  return warnings;
}

export function countDistinctKinds(items) {
  const mem = new Set();
  const chap = new Set();
  const other = new Set();

  for (const item of items || []) {
    const type = String(item?.type || "").toLowerCase();
    const key =
      item?.meta?.entity_key ||
      item?.meta?.target_key ||
      `${type}:${item?.source_id ?? item?.id ?? Math.random()}`;

    if (type === "memory") {
      mem.add(key);
      continue;
    }

    if (type === "chapter") {
      chap.add(key);
      continue;
    }

    other.add(key);
  }

  return {
    total: mem.size + chap.size + other.size,
    memories: mem.size,
    chapters: chap.size,
    others: other.size,
  };
}