// C:\HDUD_DATA\hdud-api-node\src\services\story\story-version.service.js
//
// GO LIVE 003.0 — Story Versioning Engine
// Histórico editorial persistido, diff versionado e rollback sem perda de conteúdo.

import { getPool, sql } from "../../db.js";

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function safeJson(value, fallback = {}) {
  try {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function tokenize(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/(\s+)/)
    .filter((part) => part.length > 0);
}

export function buildStoryDiff(before = "", after = "") {
  const a = tokenize(before);
  const b = tokenize(after);
  const max = Math.max(a.length, b.length);
  const rows = [];

  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) {
      if (String(a[i] || "").trim()) rows.push({ t: "eq", v: a[i] });
      continue;
    }

    if (a[i] && String(a[i]).trim()) rows.push({ t: "del", v: a[i] });
    if (b[i] && String(b[i]).trim()) rows.push({ t: "add", v: b[i] });
  }

  return rows.slice(0, 5000);
}

function summarizeDiff(rows = []) {
  const added = rows.filter((row) => row.t === "add").length;
  const removed = rows.filter((row) => row.t === "del").length;
  if (!added && !removed) return "Versão registrada sem alterações textuais relevantes.";
  return `${added} inserções e ${removed} remoções registradas no diff editorial.`;
}

async function ensureStoryVersionTable(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.identity_story_version', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.identity_story_version (
        story_version_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_identity_story_version PRIMARY KEY,
        story_id BIGINT NOT NULL,
        author_id BIGINT NOT NULL,
        version_number INT NOT NULL,
        title NVARCHAR(500) NOT NULL,
        subtitle NVARCHAR(500) NULL,
        content NVARCHAR(MAX) NOT NULL,
        diff_json NVARCHAR(MAX) NULL,
        change_summary NVARCHAR(1000) NULL,
        source_type VARCHAR(40) NOT NULL CONSTRAINT DF_identity_story_version_source_type DEFAULT ('AUTHOR_REVISION'),
        rollback_from_version_id BIGINT NULL,
        payload_json NVARCHAR(MAX) NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_identity_story_version_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_identity_story_version_story_number UNIQUE (story_id, version_number)
      );

      CREATE INDEX IX_identity_story_version_author_story
        ON dbo.identity_story_version (author_id, story_id, version_number DESC);
    END;
  `);
}

async function fetchOwnedStory({ pool, authorId, storyId }) {
  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("story_id", sql.BigInt, storyId)
    .query(`
      SELECT TOP 1
        story_id,
        author_id,
        title,
        subtitle,
        content,
        version_number,
        story_status,
        publication_status,
        updated_at
      FROM dbo.identity_story
      WHERE story_id = @story_id
        AND author_id = @author_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  return result.recordset?.[0] || null;
}

async function getLatestVersionNumber({ request, storyId, authorId }) {
  const result = await request
    .input("latest_story_id", sql.BigInt, storyId)
    .input("latest_author_id", sql.BigInt, authorId)
    .query(`
      SELECT ISNULL(MAX(version_number), 0) AS latest_version_number
      FROM dbo.identity_story_version
      WHERE story_id = @latest_story_id
        AND author_id = @latest_author_id;
    `);

  return Number(result.recordset?.[0]?.latest_version_number || 0);
}

function mapVersion(row) {
  return {
    story_version_id: Number(row.story_version_id),
    story_id: Number(row.story_id),
    author_id: Number(row.author_id),
    version_number: Number(row.version_number),
    title: row.title,
    subtitle: row.subtitle || null,
    content: row.content || "",
    diff: safeJson(row.diff_json, []),
    diff_json: row.diff_json || null,
    change_summary: row.change_summary || null,
    source_type: row.source_type || "AUTHOR_REVISION",
    rollback_from_version_id: row.rollback_from_version_id ? Number(row.rollback_from_version_id) : null,
    payload: safeJson(row.payload_json, null),
    created_at: row.created_at,
  };
}

export async function createInitialStoryVersion({ authorId, storyId, title, subtitle = null, content, payload = null } = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeStoryId = toPositiveInt(storyId);
  const safeTitle = safeText(title, "História sem título");
  const safeContent = safeText(content, "");

  if (!safeAuthorId || !safeStoryId || !safeContent) return { ok: false, error: "Dados inválidos para versionar História." };

  const pool = await getPool();
  await ensureStoryVersionTable(pool);

  const existing = await pool
    .request()
    .input("story_id", sql.BigInt, safeStoryId)
    .input("author_id", sql.BigInt, safeAuthorId)
    .query(`
      SELECT TOP 1 story_version_id, version_number
      FROM dbo.identity_story_version
      WHERE story_id = @story_id
        AND author_id = @author_id
      ORDER BY version_number ASC;
    `);

  if (existing.recordset?.[0]) {
    return {
      ok: true,
      story_version_id: Number(existing.recordset[0].story_version_id),
      version_number: Number(existing.recordset[0].version_number),
      skipped: true,
    };
  }

  const diff = buildStoryDiff("", safeContent);
  const inserted = await pool
    .request()
    .input("story_id", sql.BigInt, safeStoryId)
    .input("author_id", sql.BigInt, safeAuthorId)
    .input("version_number", sql.Int, 1)
    .input("title", sql.NVarChar(500), safeTitle)
    .input("subtitle", sql.NVarChar(500), safeText(subtitle, null))
    .input("content", sql.NVarChar(sql.MAX), safeContent)
    .input("diff_json", sql.NVarChar(sql.MAX), JSON.stringify(diff))
    .input("change_summary", sql.NVarChar(1000), "Versão inicial aprovada pelo autor.")
    .input("source_type", sql.VarChar(40), "INITIAL_APPROVAL")
    .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(payload || {}))
    .query(`
      INSERT INTO dbo.identity_story_version (
        story_id,
        author_id,
        version_number,
        title,
        subtitle,
        content,
        diff_json,
        change_summary,
        source_type,
        payload_json,
        created_at
      )
      OUTPUT INSERTED.story_version_id, INSERTED.version_number
      VALUES (
        @story_id,
        @author_id,
        @version_number,
        @title,
        @subtitle,
        @content,
        @diff_json,
        @change_summary,
        @source_type,
        @payload_json,
        SYSUTCDATETIME()
      );
    `);

  return {
    ok: true,
    story_version_id: Number(inserted.recordset?.[0]?.story_version_id),
    version_number: Number(inserted.recordset?.[0]?.version_number),
  };
}

export async function listStoryVersions({ authorId, storyId } = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeStoryId = toPositiveInt(storyId);
  if (!safeAuthorId) return { ok: false, error: "authorId inválido." };
  if (!safeStoryId) return { ok: false, error: "storyId inválido." };

  const pool = await getPool();
  await ensureStoryVersionTable(pool);

  const story = await fetchOwnedStory({ pool, authorId: safeAuthorId, storyId: safeStoryId });
  if (!story) return { ok: false, error: "História não encontrada para este autor." };

  const result = await pool
    .request()
    .input("story_id", sql.BigInt, safeStoryId)
    .input("author_id", sql.BigInt, safeAuthorId)
    .query(`
      SELECT
        story_version_id,
        story_id,
        author_id,
        version_number,
        title,
        subtitle,
        content,
        diff_json,
        change_summary,
        source_type,
        rollback_from_version_id,
        payload_json,
        created_at
      FROM dbo.identity_story_version
      WHERE story_id = @story_id
        AND author_id = @author_id
      ORDER BY version_number DESC;
    `);

  return {
    ok: true,
    story_id: safeStoryId,
    current_version_number: Number(story.version_number || 1),
    versions: (result.recordset || []).map(mapVersion),
    meta: {
      source_policy: "Histórico editorial persistido. Rollback nunca sobrescreve versões antigas; sempre cria nova versão.",
    },
  };
}

export async function createStoryVersion({ authorId, storyId, title, subtitle = null, content, changeSummary = null, payload = null } = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeStoryId = toPositiveInt(storyId);
  const safeTitle = safeText(title, "História sem título");
  const safeContent = safeText(content, "");

  if (!safeAuthorId) return { ok: false, error: "authorId inválido." };
  if (!safeStoryId) return { ok: false, error: "storyId inválido." };
  if (!safeContent || safeContent.length < 20) return { ok: false, error: "A versão precisa de conteúdo narrativo." };

  const pool = await getPool();
  await ensureStoryVersionTable(pool);

  const story = await fetchOwnedStory({ pool, authorId: safeAuthorId, storyId: safeStoryId });
  if (!story) return { ok: false, error: "História não encontrada para este autor." };

  const tx = new sql.Transaction(pool);
  await tx.begin();

  try {
    const latest = await getLatestVersionNumber({ request: tx.request(), storyId: safeStoryId, authorId: safeAuthorId });
    const nextVersion = latest + 1;
    const diff = buildStoryDiff(story.content || "", safeContent);
    const summary = safeText(changeSummary, summarizeDiff(diff));

    const inserted = await tx
      .request()
      .input("story_id", sql.BigInt, safeStoryId)
      .input("author_id", sql.BigInt, safeAuthorId)
      .input("version_number", sql.Int, nextVersion)
      .input("title", sql.NVarChar(500), safeTitle)
      .input("subtitle", sql.NVarChar(500), safeText(subtitle, null))
      .input("content", sql.NVarChar(sql.MAX), safeContent)
      .input("diff_json", sql.NVarChar(sql.MAX), JSON.stringify(diff))
      .input("change_summary", sql.NVarChar(1000), summary)
      .input("source_type", sql.VarChar(40), "AUTHOR_REVISION")
      .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(payload || {}))
      .query(`
        INSERT INTO dbo.identity_story_version (
          story_id,
          author_id,
          version_number,
          title,
          subtitle,
          content,
          diff_json,
          change_summary,
          source_type,
          payload_json,
          created_at
        )
        OUTPUT INSERTED.*
        VALUES (
          @story_id,
          @author_id,
          @version_number,
          @title,
          @subtitle,
          @content,
          @diff_json,
          @change_summary,
          @source_type,
          @payload_json,
          SYSUTCDATETIME()
        );
      `);

    await tx
      .request()
      .input("story_id", sql.BigInt, safeStoryId)
      .input("author_id", sql.BigInt, safeAuthorId)
      .input("title", sql.NVarChar(500), safeTitle)
      .input("subtitle", sql.NVarChar(500), safeText(subtitle, null))
      .input("content", sql.NVarChar(sql.MAX), safeContent)
      .input("version_number", sql.Int, nextVersion)
      .query(`
        UPDATE dbo.identity_story
        SET
          title = @title,
          subtitle = @subtitle,
          content = @content,
          version_number = @version_number,
          updated_at = SYSUTCDATETIME()
        WHERE story_id = @story_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;
      `);

    await tx.commit();

    return {
      ok: true,
      story_id: safeStoryId,
      version: mapVersion(inserted.recordset?.[0] || {}),
      current_version_number: nextVersion,
      source_policy: "Nova versão editorial persistida e História atualizada sem apagar histórico anterior.",
    };
  } catch (error) {
    try { await tx.rollback(); } catch {}
    return { ok: false, error: error?.message || "Falha ao criar versão editorial." };
  }
}

export async function rollbackStoryVersion({ authorId, storyId, targetVersionId = null, targetVersionNumber = null } = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeStoryId = toPositiveInt(storyId);
  const safeTargetVersionId = toPositiveInt(targetVersionId);
  const safeTargetVersionNumber = toPositiveInt(targetVersionNumber);

  if (!safeAuthorId) return { ok: false, error: "authorId inválido." };
  if (!safeStoryId) return { ok: false, error: "storyId inválido." };
  if (!safeTargetVersionId && !safeTargetVersionNumber) return { ok: false, error: "Informe a versão para rollback." };

  const pool = await getPool();
  await ensureStoryVersionTable(pool);

  const story = await fetchOwnedStory({ pool, authorId: safeAuthorId, storyId: safeStoryId });
  if (!story) return { ok: false, error: "História não encontrada para este autor." };

  const targetRequest = pool
    .request()
    .input("story_id", sql.BigInt, safeStoryId)
    .input("author_id", sql.BigInt, safeAuthorId);

  if (safeTargetVersionId) targetRequest.input("story_version_id", sql.BigInt, safeTargetVersionId);
  if (safeTargetVersionNumber) targetRequest.input("version_number", sql.Int, safeTargetVersionNumber);

  const targetResult = await targetRequest.query(`
    SELECT TOP 1 *
    FROM dbo.identity_story_version
    WHERE story_id = @story_id
      AND author_id = @author_id
      AND ${safeTargetVersionId ? "story_version_id = @story_version_id" : "version_number = @version_number"}
    ORDER BY version_number DESC;
  `);

  const target = targetResult.recordset?.[0] || null;
  if (!target) return { ok: false, error: "Versão de rollback não encontrada." };

  const tx = new sql.Transaction(pool);
  await tx.begin();

  try {
    const latest = await getLatestVersionNumber({ request: tx.request(), storyId: safeStoryId, authorId: safeAuthorId });
    const nextVersion = latest + 1;
    const diff = buildStoryDiff(story.content || "", target.content || "");
    const summary = `Rollback editorial para a versão ${target.version_number}.`;

    const inserted = await tx
      .request()
      .input("story_id", sql.BigInt, safeStoryId)
      .input("author_id", sql.BigInt, safeAuthorId)
      .input("version_number", sql.Int, nextVersion)
      .input("title", sql.NVarChar(500), target.title)
      .input("subtitle", sql.NVarChar(500), target.subtitle)
      .input("content", sql.NVarChar(sql.MAX), target.content)
      .input("diff_json", sql.NVarChar(sql.MAX), JSON.stringify(diff))
      .input("change_summary", sql.NVarChar(1000), summary)
      .input("source_type", sql.VarChar(40), "ROLLBACK")
      .input("rollback_from_version_id", sql.BigInt, target.story_version_id)
      .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify({ rollback_to_version_number: target.version_number }))
      .query(`
        INSERT INTO dbo.identity_story_version (
          story_id,
          author_id,
          version_number,
          title,
          subtitle,
          content,
          diff_json,
          change_summary,
          source_type,
          rollback_from_version_id,
          payload_json,
          created_at
        )
        OUTPUT INSERTED.*
        VALUES (
          @story_id,
          @author_id,
          @version_number,
          @title,
          @subtitle,
          @content,
          @diff_json,
          @change_summary,
          @source_type,
          @rollback_from_version_id,
          @payload_json,
          SYSUTCDATETIME()
        );
      `);

    await tx
      .request()
      .input("story_id", sql.BigInt, safeStoryId)
      .input("author_id", sql.BigInt, safeAuthorId)
      .input("title", sql.NVarChar(500), target.title)
      .input("subtitle", sql.NVarChar(500), target.subtitle)
      .input("content", sql.NVarChar(sql.MAX), target.content)
      .input("version_number", sql.Int, nextVersion)
      .query(`
        UPDATE dbo.identity_story
        SET
          title = @title,
          subtitle = @subtitle,
          content = @content,
          version_number = @version_number,
          updated_at = SYSUTCDATETIME()
        WHERE story_id = @story_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;
      `);

    await tx.commit();

    return {
      ok: true,
      story_id: safeStoryId,
      rolled_back_to_version_number: Number(target.version_number),
      version: mapVersion(inserted.recordset?.[0] || {}),
      current_version_number: nextVersion,
      source_policy: "Rollback criado como nova versão. Nenhuma versão anterior foi apagada.",
    };
  } catch (error) {
    try { await tx.rollback(); } catch {}
    return { ok: false, error: error?.message || "Falha ao executar rollback editorial." };
  }
}
