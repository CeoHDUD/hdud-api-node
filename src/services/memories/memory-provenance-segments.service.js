import { sql } from "../../db.js";

export const MEMORY_PROVENANCE_GRANULARITY = "PERSISTED_SEGMENTS_V1";
export const MEMORY_ORIGIN = Object.freeze({
  AUTHOR_SOURCE: "AUTHOR_SOURCE",
  AI_GENERATED: "AI_GENERATED",
  AUTHOR_EDIT: "AUTHOR_EDIT",
});

function tokenize(text) {
  const value = String(text ?? "");
  const re = /(\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_])/gu;
  const out = [];
  let m;
  while ((m = re.exec(value)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function mergeSegments(segments) {
  const out = [];
  for (const raw of segments || []) {
    const text = String(raw?.content ?? raw?.text ?? "");
    if (!text) continue;
    const origin_code = String(raw?.origin_code || raw?.origin || MEMORY_ORIGIN.AUTHOR_EDIT);
    const last = out[out.length - 1];
    if (last && last.origin_code === origin_code && (last.source_proposal_id ?? null) === (raw.source_proposal_id ?? null)) {
      last.content += text;
    } else {
      out.push({ origin_code, content: text, source_proposal_id: raw.source_proposal_id ?? null, metadata_json: raw.metadata_json ?? null });
    }
  }
  return out;
}

function sourceOriginAt(segments, position) {
  let cursor = 0;
  for (const s of segments || []) {
    const len = String(s.content ?? "").length;
    if (position >= cursor && position < cursor + len) return s.origin_code || MEMORY_ORIGIN.AUTHOR_EDIT;
    cursor += len;
  }
  return MEMORY_ORIGIN.AUTHOR_EDIT;
}

function fallbackPrefixSuffix(sourceText, targetText, sourceSegments, insertedOrigin, sourceProposalId = null) {
  let prefix = 0;
  const min = Math.min(sourceText.length, targetText.length);
  while (prefix < min && sourceText[prefix] === targetText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < min - prefix && sourceText[sourceText.length - 1 - suffix] === targetText[targetText.length - 1 - suffix]) suffix++;
  const out = [];
  if (prefix) out.push({ origin_code: sourceOriginAt(sourceSegments, 0), content: targetText.slice(0, prefix), source_proposal_id: null });
  const middleEnd = targetText.length - suffix;
  if (middleEnd > prefix) out.push({ origin_code: insertedOrigin, content: targetText.slice(prefix, middleEnd), source_proposal_id: sourceProposalId });
  if (suffix) out.push({ origin_code: sourceOriginAt(sourceSegments, Math.max(0, sourceText.length - suffix)), content: targetText.slice(middleEnd), source_proposal_id: null });
  return mergeSegments(out);
}

export function transformSegments({ sourceText, targetText, sourceSegments, insertedOrigin, sourceProposalId = null }) {
  sourceText = String(sourceText ?? "");
  targetText = String(targetText ?? "");
  const normalizedSource = mergeSegments(sourceSegments?.length ? sourceSegments : [{ origin_code: MEMORY_ORIGIN.AUTHOR_SOURCE, content: sourceText }]);
  if (sourceText === targetText) return normalizedSource;

  const a = tokenize(sourceText);
  const b = tokenize(targetText);
  if (!a.length) return targetText ? [{ origin_code: insertedOrigin, content: targetText, source_proposal_id: sourceProposalId }] : [];
  if (a.length > 2500 || b.length > 2500 || a.length * b.length > 2500000) {
    return fallbackPrefixSuffix(sourceText, targetText, normalizedSource, insertedOrigin, sourceProposalId);
  }

  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  while (j < b.length) {
    if (i < a.length && a[i].text === b[j].text) {
      out.push({ origin_code: sourceOriginAt(normalizedSource, a[i].start), content: b[j].text, source_proposal_id: null });
      i++; j++;
    } else if (i < a.length && dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      out.push({ origin_code: insertedOrigin, content: b[j].text, source_proposal_id: sourceProposalId });
      j++;
    }
  }
  return mergeSegments(out);
}

async function loadVersion(pool, versionId) {
  const r = await pool.request().input("version_id", sql.Int, Number(versionId)).query(`
    SELECT TOP 1 version_id,memory_id,version_number,title,content,created_at,created_by,origin_code,source_proposal_id
    FROM dbo.identity_memory_versions WHERE version_id=@version_id;
  `);
  return r.recordset?.[0] || null;
}

async function loadPreviousVersion(pool, memoryId, versionNumber) {
  const r = await pool.request().input("memory_id", sql.Int, Number(memoryId)).input("version_number", sql.Int, Number(versionNumber)).query(`
    SELECT TOP 1 version_id,memory_id,version_number,title,content,created_at,created_by,origin_code,source_proposal_id
    FROM dbo.identity_memory_versions WHERE memory_id=@memory_id AND version_number < @version_number
    ORDER BY version_number DESC, version_id DESC;
  `);
  return r.recordset?.[0] || null;
}

export async function loadPersistedMemorySegments(pool, versionId) {
  const r = await pool.request().input("version_id", sql.Int, Number(versionId)).query(`
    SELECT segment_id,memory_id,memory_version_id,segment_order,segment_start,segment_end,origin_code,source_proposal_id,content,metadata_json,created_at
    FROM dbo.identity_memory_version_provenance_segment
    WHERE memory_version_id=@version_id ORDER BY segment_order,segment_id;
  `);
  return r.recordset || [];
}

export async function persistMemorySegments(pool, { memoryId, versionId, segments }) {
  const merged = mergeSegments(segments);
  let pos = 0;
  const payload = merged.map((s, idx) => {
    const start = pos; pos += s.content.length;
    return { segment_order: idx + 1, segment_start: start, segment_end: pos, origin_code: s.origin_code, source_proposal_id: s.source_proposal_id ?? null, content: s.content, metadata_json: s.metadata_json ?? null };
  });
  await pool.request()
    .input("MemoryId", sql.Int, Number(memoryId))
    .input("MemoryVersionId", sql.Int, Number(versionId))
    .input("SegmentsJson", sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .execute("dbo.p_ReplaceMemoryVersionProvenanceSegments");
  return payload;
}

export async function ensureMemoryVersionProvenance(pool, versionId, stack = new Set()) {
  const safeId = Number(versionId);
  if (!safeId || stack.has(safeId)) return [];
  const existing = await loadPersistedMemorySegments(pool, safeId);
  if (existing.length) return existing.map(s => ({ origin_code: s.origin_code, content: s.content, source_proposal_id: s.source_proposal_id ?? null }));

  stack.add(safeId);
  const version = await loadVersion(pool, safeId);
  if (!version) return [];
  const content = String(version.content ?? "");
  let segments;
  const origin = String(version.origin_code || "").toUpperCase();

  if (origin === MEMORY_ORIGIN.AUTHOR_SOURCE || Number(version.version_number) === 1) {
    segments = [{ origin_code: MEMORY_ORIGIN.AUTHOR_SOURCE, content }];
  } else if (origin === "AI_ACCEPTED" && version.source_proposal_id) {
    const pr = await pool.request().input("proposal_id", sql.BigInt, Number(version.source_proposal_id)).query(`
      SELECT TOP 1 proposal_id,source_version_id,source_content,proposed_content,accepted_content,acceptance_mode
      FROM dbo.identity_memory_ai_proposal WHERE proposal_id=@proposal_id;
    `);
    const proposal = pr.recordset?.[0] || null;
    const sourceVersion = proposal?.source_version_id ? await loadVersion(pool, proposal.source_version_id) : await loadPreviousVersion(pool, version.memory_id, version.version_number);
    const sourceText = String(proposal?.source_content ?? sourceVersion?.content ?? "");
    const sourceSegments = sourceVersion ? await ensureMemoryVersionProvenance(pool, sourceVersion.version_id, stack) : [{ origin_code: MEMORY_ORIGIN.AUTHOR_SOURCE, content: sourceText }];
    const proposedText = String(proposal?.proposed_content ?? content);
    segments = transformSegments({ sourceText, targetText: proposedText, sourceSegments, insertedOrigin: MEMORY_ORIGIN.AI_GENERATED, sourceProposalId: Number(version.source_proposal_id) });
    if (proposedText !== content) {
      segments = transformSegments({ sourceText: proposedText, targetText: content, sourceSegments: segments, insertedOrigin: MEMORY_ORIGIN.AUTHOR_EDIT, sourceProposalId: null });
    }
  } else {
    const previous = await loadPreviousVersion(pool, version.memory_id, version.version_number);
    if (!previous) segments = [{ origin_code: MEMORY_ORIGIN.AUTHOR_EDIT, content }];
    else {
      const previousSegments = await ensureMemoryVersionProvenance(pool, previous.version_id, stack);
      segments = transformSegments({ sourceText: String(previous.content ?? ""), targetText: content, sourceSegments: previousSegments, insertedOrigin: MEMORY_ORIGIN.AUTHOR_EDIT });
    }
  }

  await persistMemorySegments(pool, { memoryId: version.memory_id, versionId: version.version_id, segments });
  stack.delete(safeId);
  return mergeSegments(segments);
}

export async function getCurrentMemoryProvenance(pool, memoryId) {
  const r = await pool.request().input("memory_id", sql.Int, Number(memoryId)).query(`
    SELECT TOP 1 version_id,memory_id,version_number,title,content,origin_code,source_proposal_id
    FROM dbo.identity_memory_versions WHERE memory_id=@memory_id ORDER BY version_number DESC,version_id DESC;
  `);
  const version = r.recordset?.[0] || null;
  if (!version) return null;
  await ensureMemoryVersionProvenance(pool, version.version_id);
  const persisted = await loadPersistedMemorySegments(pool, version.version_id);
  return {
    memory_id: Number(memoryId),
    memory_version_id: Number(version.version_id),
    version_number: Number(version.version_number),
    version_origin_code: version.origin_code || null,
    source_proposal_id: version.source_proposal_id ?? null,
    provenance_granularity: MEMORY_PROVENANCE_GRANULARITY,
    has_ai_provenance: persisted.some(s => String(s.origin_code).toUpperCase() === MEMORY_ORIGIN.AI_GENERATED),
    segments: persisted.map(s => ({ segment_id: s.segment_id, segment_order: s.segment_order, start: s.segment_start, end: s.segment_end, origin: s.origin_code, source_proposal_id: s.source_proposal_id ?? null, text: s.content })),
  };
}
