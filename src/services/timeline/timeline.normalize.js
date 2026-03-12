// C:\HDUD_DATA\hdud-api-node\src\services\timeline\timeline.normalize.js

function safeDateMs(value) {
  if (!value) return null;

  const d1 = new Date(value);
  if (!Number.isNaN(d1.getTime())) return d1.getTime();

  const d2 = new Date(String(value).replace(" ", "T"));
  if (!Number.isNaN(d2.getTime())) return d2.getTime();

  return null;
}

function normalizeText(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function normalizeIsoOrNow(value) {
  const ms = safeDateMs(value);
  if (typeof ms === "number") return new Date(ms).toISOString();
  return new Date().toISOString();
}

function makePreview(text, maxLen = 160) {
  const s = normalizeText(text, "");
  if (!s) return null;

  const oneLine = s.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;

  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

function normalizeTypeToken(input) {
  const raw = String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) return "";

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

  if (
    raw === "version" ||
    raw === "versions" ||
    raw === "versao" ||
    raw === "versoes"
  ) {
    return "version";
  }

  if (raw === "rollback" || raw === "reverted" || raw === "revert") {
    return "rollback";
  }

  if (raw.includes("memory") || raw.includes("memoria")) return "memory";
  if (raw.includes("chapter") || raw.includes("capitulo")) return "chapter";
  if (raw.includes("version") || raw.includes("versao")) return "version";
  if (raw.includes("rollback") || raw.includes("revert")) return "rollback";

  return raw;
}

function mkNav(kind, id, extra) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return "/";

  const k = String(kind || "").toLowerCase();

  if (k === "memory") return `/memories/${n}`;
  if (k === "chapter") return `/chapters/${n}`;

  if (k === "version") {
    const v = extra?.version_number ?? extra?.version ?? null;
    return v != null ? `/memories/${n}?version=${Number(v)}` : `/memories/${n}`;
  }

  return "/";
}

function resolveNarrativeType(row) {
  const explicit = normalizeTypeToken(
    row?.event_type ||
      row?.type ||
      row?.kind ||
      row?.entity_type ||
      row?.target_type ||
      row?.source_type
  );

  if (explicit) return explicit;

  const memoryId = Number(row?.memory_id);
  const chapterId = Number(row?.chapter_id);

  if (Number.isInteger(memoryId) && memoryId > 0 && (!Number.isInteger(chapterId) || chapterId <= 0)) {
    return "memory";
  }

  if (Number.isInteger(chapterId) && chapterId > 0 && (!Number.isInteger(memoryId) || memoryId <= 0)) {
    return "chapter";
  }

  return "event";
}

function narrativeEntityKey(type, row) {
  const memoryId = Number(row?.memory_id);
  const chapterId = Number(row?.chapter_id);

  if (type === "memory" && Number.isInteger(memoryId) && memoryId > 0) {
    return `memory:${memoryId}`;
  }

  if (type === "chapter" && Number.isInteger(chapterId) && chapterId > 0) {
    return `chapter:${chapterId}`;
  }

  const eventId =
    row?.narrative_event_id ??
    row?.event_id ??
    row?.id ??
    row?.source_id ??
    `${type}:${row?.title || row?.created_at || Date.now()}`;

  return `event:${String(eventId)}`;
}

export function normalizeNarrativeEventRow(row) {
  if (!row || typeof row !== "object") return null;

  const type = resolveNarrativeType(row);

  const memoryId = Number(row?.memory_id);
  const chapterId = Number(row?.chapter_id);

  const title =
    normalizeText(
      row?.title ||
        row?.name ||
        row?.headline ||
        row?.label,
      type === "memory"
        ? "(Memória sem título)"
        : type === "chapter"
        ? "(Capítulo sem título)"
        : "(Evento)"
    );

  const at = normalizeIsoOrNow(
    row?.event_at ||
      row?.activity_at ||
      row?.occurred_at ||
      row?.updated_at ||
      row?.created_at
  );

  const note =
    makePreview(
      row?.note ||
        row?.summary ||
        row?.preview ||
        row?.description ||
        row?.metadata_json
    ) || undefined;

  const nav =
    type === "memory" && Number.isInteger(memoryId) && memoryId > 0
      ? mkNav("memory", memoryId)
      : type === "chapter" && Number.isInteger(chapterId) && chapterId > 0
      ? mkNav("chapter", chapterId)
      : "/";

  const sourceId =
    type === "memory" && Number.isInteger(memoryId) && memoryId > 0
      ? memoryId
      : type === "chapter" && Number.isInteger(chapterId) && chapterId > 0
      ? chapterId
      : row?.narrative_event_id ?? row?.event_id ?? row?.id ?? null;

  const entityKey = narrativeEntityKey(type, row);

  return {
    type,
    title,
    date: at,
    source_id: sourceId,
    memory_id: Number.isInteger(memoryId) && memoryId > 0 ? memoryId : null,
    chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
    note,
    meta: {
      nav,
      activity_at: at,
      date_source: "activity_at",
      entity_key: entityKey,
      source_mode: "narrative_event",
      event_type: type,
      event_id: row?.narrative_event_id ?? row?.event_id ?? row?.id ?? null,
      memory_id: Number.isInteger(memoryId) && memoryId > 0 ? memoryId : null,
      chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
    },
    raw: row,
  };
}

export function normalizeMemoryFallbackRow(row) {
  if (!row || typeof row !== "object") return null;

  const memoryId = Number(row?.memory_id);
  if (!Number.isInteger(memoryId) || memoryId <= 0) return null;

  const chapterId = Number(row?.chapter_id);
  const at = normalizeIsoOrNow(row?.activity_at || row?.last_version_at || row?.updated_at || row?.created_at);
  const title = normalizeText(row?.title, "(Memória sem título)");
  const note =
    makePreview(
      row?.content ||
        row?.summary ||
        row?.preview
    ) || undefined;

  return {
    type: "memory",
    title,
    date: at,
    source_id: memoryId,
    memory_id: memoryId,
    chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
    note,
    meta: {
      nav: mkNav("memory", memoryId),
      activity_at: at,
      date_source: "activity_at",
      entity_key: `memory:${memoryId}`,
      source_mode: "fallback_memory",
      memory_id: memoryId,
      chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
      preview: note || null,
    },
    raw: {
      ...row,
      type: "memory",
      memory_id: memoryId,
      chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
      meta: {
        nav: mkNav("memory", memoryId),
        memory_id: memoryId,
        chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
      },
    },
  };
}

export function normalizeChapterFallbackRow(row) {
  if (!row || typeof row !== "object") return null;

  const chapterId = Number(row?.chapter_id);
  if (!Number.isInteger(chapterId) || chapterId <= 0) return null;

  const at = normalizeIsoOrNow(row?.activity_at || row?.published_at || row?.updated_at || row?.created_at);
  const title = normalizeText(row?.title, "(Capítulo sem título)");
  const note =
    makePreview(
      row?.description ||
        row?.summary ||
        row?.preview
    ) || undefined;

  return {
    type: "chapter",
    title,
    date: at,
    source_id: chapterId,
    chapter_id: chapterId,
    note,
    meta: {
      nav: mkNav("chapter", chapterId),
      activity_at: at,
      date_source: "activity_at",
      entity_key: `chapter:${chapterId}`,
      source_mode: "fallback_chapter",
      chapter_id: chapterId,
      status: row?.status ?? null,
      published_at: row?.published_at ?? null,
      description: note || null,
    },
    raw: {
      ...row,
      type: "chapter",
      chapter_id: chapterId,
      meta: {
        nav: mkNav("chapter", chapterId),
        chapter_id: chapterId,
      },
    },
  };
}

function compareTimelineDesc(a, b) {
  const da = safeDateMs(a?.date) ?? -Infinity;
  const db = safeDateMs(b?.date) ?? -Infinity;
  if (da !== db) return db - da;

  const pa = a?.meta?.source_mode === "narrative_event" ? 0 : 1;
  const pb = b?.meta?.source_mode === "narrative_event" ? 0 : 1;
  if (pa !== pb) return pa - pb;

  const ta = String(a?.type || "");
  const tb = String(b?.type || "");
  if (ta !== tb) return ta < tb ? -1 : 1;

  const सा = String(a?.source_id ?? "");
  const sb = String(b?.source_id ?? "");
  if (सा < sb) return -1;
  if (सा > sb) return 1;

  return 0;
}

export function mergeHybridTimeline({
  eventItems,
  memoryFallbackItems,
  chapterFallbackItems,
}) {
  const merged = [];
  const seenEntityKeys = new Set();

  for (const item of eventItems || []) {
    if (!item) continue;
    merged.push(item);

    const ek = item?.meta?.entity_key;
    if (typeof ek === "string" && (ek.startsWith("memory:") || ek.startsWith("chapter:"))) {
      seenEntityKeys.add(ek);
    }
  }

  for (const item of memoryFallbackItems || []) {
    if (!item) continue;
    const ek = item?.meta?.entity_key;
    if (ek && seenEntityKeys.has(ek)) continue;
    merged.push(item);
    if (ek) seenEntityKeys.add(ek);
  }

  for (const item of chapterFallbackItems || []) {
    if (!item) continue;
    const ek = item?.meta?.entity_key;
    if (ek && seenEntityKeys.has(ek)) continue;
    merged.push(item);
    if (ek) seenEntityKeys.add(ek);
  }

  return merged.sort(compareTimelineDesc);
}