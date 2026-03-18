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

  if (explicit === "memory") return "memory";
  if (explicit === "chapter") return "chapter";
  if (explicit === "version") return "version";
  if (explicit === "rollback") return "rollback";

  const memoryId = Number(row?.memory_id);
  const chapterId = Number(row?.chapter_id);

  if (
    Number.isInteger(memoryId) &&
    memoryId > 0 &&
    (!Number.isInteger(chapterId) || chapterId <= 0)
  ) {
    return "memory";
  }

  if (
    Number.isInteger(chapterId) &&
    chapterId > 0 &&
    (!Number.isInteger(memoryId) || memoryId <= 0)
  ) {
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

function tryParseJsonObject(value) {
  if (value == null) return null;

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function firstNonEmptyString(candidates, fallback = "") {
  for (const item of candidates || []) {
    const s = normalizeText(item, "");
    if (s) return s;
  }
  return fallback;
}

function resolveMetadataTitle(row, type, metadata = null) {
  const fallback =
    type === "memory"
      ? "(Memória sem título)"
      : type === "chapter"
      ? "(Capítulo sem título)"
      : type === "version"
      ? "(Versão)"
      : "(Evento)";

  return firstNonEmptyString(
    [
      row?.title,
      row?.name,
      row?.headline,
      row?.label,
      metadata?.title,
      metadata?.name,
      metadata?.headline,
      metadata?.label,
      metadata?.event_title,
      metadata?.memory_title,
      metadata?.chapter_title,
      row?.memory_title,
      row?.chapter_title,
    ],
    fallback
  );
}

function resolveMetadataNote(row, metadata = null) {
  return (
    makePreview(
      row?.note ||
        row?.summary ||
        row?.preview ||
        row?.description ||
        metadata?.note ||
        metadata?.summary ||
        metadata?.preview ||
        metadata?.description ||
        metadata?.subtitle ||
        row?.memory_content ||
        row?.chapter_description
    ) || undefined
  );
}

function editorialDaysSince(dateIso) {
  const ms = safeDateMs(dateIso);
  if (typeof ms !== "number") return 999999;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function computeRecencyPoints(dateIso) {
  const days = editorialDaysSince(dateIso);
  if (days <= 1) return 5;
  if (days <= 3) return 4;
  if (days <= 7) return 3;
  if (days <= 14) return 2;
  if (days <= 30) return 1;
  return 0;
}

function computeNarrativeEventWeight(rawEventType, type) {
  const raw = String(rawEventType || "").trim().toLowerCase();

  if (raw === "chapter_created") return 10;
  if (raw === "memory_created") return 8;
  if (raw === "memory_updated") return 6;
  if (raw === "memory_version") return 5;
  if (raw === "memory_linked_to_chapter") return 4;
  if (raw === "memory_reordered") return 3;
  if (raw === "chapter_updated") return 4;
  if (raw === "chapter_published") return 7;
  if (raw === "rollback") return 2;

  if (type === "chapter") return 4;
  if (type === "memory") return 3;
  if (type === "version") return 5;

  return 1;
}

function resolveCardLevel(editorialScore) {
  if (editorialScore >= 12) return "hero";
  if (editorialScore >= 7) return "standard";
  return "base";
}

function resolveEditorialLabel(editorialScore) {
  const level = resolveCardLevel(editorialScore);
  if (level === "hero") return "Alta relevância";
  if (level === "standard") return "Boa relevância";
  return "Base narrativa";
}

function humanizeNarrativeEventType(rawEventType, type) {
  const raw = String(rawEventType || "").trim().toLowerCase();

  if (raw === "memory_created") return "Criação da memória";
  if (raw === "memory_updated") return "Atualização da memória";
  if (raw === "memory_version") return "Nova versão publicada";
  if (raw === "memory_linked_to_chapter") return "Vinculação ao capítulo";
  if (raw === "memory_reordered") return "Reordenação narrativa";
  if (raw === "chapter_created") return "Criação do capítulo";
  if (raw === "chapter_updated") return "Atualização do capítulo";
  if (raw === "chapter_published") return "Publicação do capítulo";
  if (raw === "rollback") return "Restauração narrativa";

  if (type === "memory") return "Movimento da memória";
  if (type === "chapter") return "Movimento do capítulo";
  if (type === "version") return "Movimento de versão";

  return "Movimento narrativo";
}

function buildEditorialMeta({
  type,
  at,
  sourceMode,
  rawEventType,
  chapterIsPrimary,
  hasVersionActivity,
}) {
  const chapterWeight = chapterIsPrimary ? 3 : 0;
  const memoryRecency = computeRecencyPoints(at);
  const versionActivity = hasVersionActivity ? 2 : 0;
  const narrativeEventWeight =
    sourceMode === "narrative_event"
      ? computeNarrativeEventWeight(rawEventType, type)
      : type === "memory"
      ? 2
      : type === "chapter"
      ? 1
      : 0;

  const editorialScore =
    chapterWeight +
    memoryRecency +
    versionActivity +
    narrativeEventWeight;

  const editorialReason = [
    chapterWeight ? `chapter_primary:+${chapterWeight}` : null,
    memoryRecency ? `recency:+${memoryRecency}` : null,
    versionActivity ? `version_activity:+${versionActivity}` : null,
    narrativeEventWeight ? `narrative_event:+${narrativeEventWeight}` : null,
  ].filter(Boolean);

  return {
    editorial_score: editorialScore,
    editorial_reason: editorialReason,
    editorial_label: resolveEditorialLabel(editorialScore),
    card_level: resolveCardLevel(editorialScore),
    editorial_breakdown: {
      chapter_weight: chapterWeight,
      memory_recency: memoryRecency,
      version_activity: versionActivity,
      narrative_event_weight: narrativeEventWeight,
    },
  };
}

export function normalizeNarrativeEventRow(row) {
  if (!row || typeof row !== "object") return null;

  const type = resolveNarrativeType(row);
  const metadata = tryParseJsonObject(row?.metadata_json ?? row?.metadata);

  const memoryId = Number(row?.memory_id);
  const chapterId = Number(row?.chapter_id);
  const narrativeChapterId = Number(row?.narrative_chapter_id);
  const resolvedChapterId = Number(row?.resolved_chapter_id);
  const chapterIsPrimary = Number(row?.chapter_is_primary || 0) === 1;
  const rawEventType = normalizeText(row?.event_type, "");

  const title = resolveMetadataTitle(row, type, metadata);

  const at = normalizeIsoOrNow(
    row?.event_at ||
      row?.activity_at ||
      row?.occurred_at ||
      row?.updated_at ||
      row?.created_at
  );

  const note = resolveMetadataNote(row, metadata);

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

  const editorial = buildEditorialMeta({
    type,
    at,
    sourceMode: "narrative_event",
    rawEventType,
    chapterIsPrimary,
    hasVersionActivity: rawEventType === "memory_version",
  });

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
      raw_event_type: rawEventType || null,
      narrative_line_label: humanizeNarrativeEventType(rawEventType, type),
      event_id: row?.narrative_event_id ?? row?.event_id ?? row?.id ?? null,
      memory_id: Number.isInteger(memoryId) && memoryId > 0 ? memoryId : null,
      chapter_id: Number.isInteger(chapterId) && chapterId > 0 ? chapterId : null,
      narrative_chapter_id:
        Number.isInteger(narrativeChapterId) && narrativeChapterId > 0
          ? narrativeChapterId
          : null,
      resolved_chapter_id:
        Number.isInteger(resolvedChapterId) && resolvedChapterId > 0
          ? resolvedChapterId
          : null,
      resolved_chapter_title: normalizeText(row?.chapter_title, "") || null,
      resolved_chapter_description:
        normalizeText(row?.chapter_description, "") || null,
      chapter_is_primary: chapterIsPrimary,
      title_source: normalizeText(
        row?.title || row?.name || row?.headline || row?.label,
        ""
      )
        ? "row"
        : normalizeText(
            metadata?.title || metadata?.chapter_title || metadata?.memory_title,
            ""
          )
        ? "metadata_json"
        : normalizeText(row?.memory_title || row?.chapter_title, "")
        ? "resolved_lookup"
        : "fallback",
      ...editorial,
    },
    raw: row,
  };
}

export function normalizeMemoryFallbackRow(row) {
  if (!row || typeof row !== "object") return null;

  const memoryId = Number(row?.memory_id);
  if (!Number.isInteger(memoryId) || memoryId <= 0) return null;

  const chapterId = Number(row?.chapter_id);
  const chapterIsPrimary = Number(row?.chapter_is_primary || 0) === 1;
  const at = normalizeIsoOrNow(
    row?.activity_at || row?.last_version_at || row?.updated_at || row?.created_at
  );
  const title = normalizeText(row?.title, "(Memória sem título)");
  const note =
    makePreview(row?.content || row?.summary || row?.preview) || undefined;

  const editorial = buildEditorialMeta({
    type: "memory",
    at,
    sourceMode: "fallback_memory",
    rawEventType: null,
    chapterIsPrimary,
    hasVersionActivity: Boolean(row?.last_version_at),
  });

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
      chapter_title: normalizeText(row?.chapter_title, "") || null,
      chapter_description: normalizeText(row?.chapter_description, "") || null,
      chapter_is_primary: chapterIsPrimary,
      chapter_relation: chapterIsPrimary
        ? "primary"
        : row?.chapter_id
        ? "secondary"
        : null,
      preview: note || null,
      raw_event_type: null,
      narrative_line_label: "Presença da memória na narrativa",
      title_source: normalizeText(row?.title, "") ? "row" : "fallback",
      ...editorial,
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
        chapter_is_primary: chapterIsPrimary,
      },
    },
  };
}

export function normalizeChapterFallbackRow(row) {
  if (!row || typeof row !== "object") return null;

  const chapterId = Number(row?.chapter_id);
  if (!Number.isInteger(chapterId) || chapterId <= 0) return null;

  const at = normalizeIsoOrNow(
    row?.activity_at || row?.published_at || row?.updated_at || row?.created_at
  );
  const title = normalizeText(row?.title, "(Capítulo sem título)");
  const note =
    makePreview(row?.description || row?.summary || row?.preview) || undefined;

  const editorial = buildEditorialMeta({
    type: "chapter",
    at,
    sourceMode: "fallback_chapter",
    rawEventType: null,
    chapterIsPrimary: false,
    hasVersionActivity: false,
  });

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
      raw_event_type: null,
      narrative_line_label: "Presença do capítulo na narrativa",
      title_source: normalizeText(row?.title, "") ? "row" : "fallback",
      ...editorial,
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
  const sa = Number(a?.meta?.editorial_score || 0);
  const sb = Number(b?.meta?.editorial_score || 0);
  if (sa !== sb) return sb - sa;

  const da = safeDateMs(a?.meta?.activity_at || a?.date) ?? -Infinity;
  const db = safeDateMs(b?.meta?.activity_at || b?.date) ?? -Infinity;
  if (da !== db) return db - da;

  const pa = a?.meta?.source_mode === "narrative_event" ? 0 : 1;
  const pb = b?.meta?.source_mode === "narrative_event" ? 0 : 1;
  if (pa !== pb) return pa - pb;

  const ta = String(a?.type || "");
  const tb = String(b?.type || "");
  if (ta !== tb) return ta < tb ? -1 : 1;

  const ia = Number(a?.source_id || 0);
  const ib = Number(b?.source_id || 0);
  return ib - ia;
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
    if (
      typeof ek === "string" &&
      (ek.startsWith("memory:") || ek.startsWith("chapter:"))
    ) {
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