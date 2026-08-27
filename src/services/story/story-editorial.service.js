// C:\HDUD_DATA\hdud-api-node\src\services\story\story-editorial.service.js
//
// GO LIVE 008.3 — CHAT 03
// Persistência da História aprovada pelo autor no schema real do HDUD_CORE.

import { getPool, sql } from "../../db.js";
import { createInitialStoryVersion } from "./story-version.service.js";

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeMemoryId(value) {
  return toPositiveInt(value?.memory_id ?? value?.id ?? value);
}

function normalizeMemoryOrigin(value) {
  const origin = safeText(value, "AI").toUpperCase();
  return origin === "AUTHOR" || origin === "AUTOR" ? "AUTHOR" : "AI";
}

function normalizeEditorialMemories(memories = [], explicitOrigins = {}) {
  return asArray(memories)
    .map((memory) => {
      const memoryId = normalizeMemoryId(memory);
      if (!memoryId) return null;
      return {
        memory_id: memoryId,
        narrative_order: toPositiveInt(memory?.narrative_order ?? memory?.sort_order ?? memory?.order_index) || null,
        image_url: safeText(memory?.image_url || memory?.cover_url || memory?.media_url, null),
        media_id: toPositiveInt(memory?.media_id),
        editorial_origin: normalizeMemoryOrigin(
          memory?.editorial_origin ??
          memory?.origin ??
          explicitOrigins?.[String(memoryId)]
        ),
      };
    })
    .filter(Boolean);
}

function safeJson(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return fallback;
  }
}

function normalizeGenerationPayload(payload = {}) {
  return {
    ...(payload || {}),
    truth_prompt: {
      ...(payload?.truth_prompt || {}),
      instruction_version:
        payload?.truth_prompt?.instruction_version || "GO_LIVE_004_5_TRUTH_PROMPT",
      keep_only: true,
      forbidden_inference: true,
      forbidden_causality_without_evidence: true,
      forbidden_emotions_without_evidence: true,
      forbidden_intentions_without_evidence: true,
      forbidden_characters_without_evidence: true,
      forbidden_dates_without_evidence: true,
      forbidden_places_without_evidence: true,
    },
    truth_policy: {
      ...(payload?.truth_policy || {}),
      source_policy:
        "História aprovada preserva o manuscrito editado e a seleção documental usada na geração.",
      author_sovereignty: true,
      evidence_required: true,
    },
  };
}

function normalizeTimelineItem(item, index = 0) {
  const rawDate =
    item?.event_at ??
    item?.event_date ??
    item?.memory_date ??
    item?.timeline_at ??
    null;

  const parsedDate = rawDate ? new Date(rawDate) : null;
  const validDate = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate
    : new Date();

  return {
    memory_id: normalizeMemoryId(item?.memory_id),
    event_type: safeText(item?.event_type || item?.type, "memory").slice(0, 50),
    event_title: safeText(item?.event_title || item?.title, "Marco narrativo").slice(0, 220),
    event_description: safeText(item?.event_description || item?.description, null),
    event_at: validDate,
    event_order: index + 1,
    source_date_kind: safeText(item?.source_date_kind, "created_at").slice(0, 30),
    metadata_json: safeJson(item || {}),
  };
}

async function assertStoryCandidateOwnership({ tx, authorId, sourceStoryId }) {
  const result = await tx
    .request()
    .input("author_id", sql.Int, authorId)
    .input("story_id", sql.Int, sourceStoryId)
    .query(`
      SELECT TOP 1 story_id
      FROM dbo.identity_narrative_story
      WHERE story_id = @story_id
        AND author_id = @author_id
        AND ISNULL(is_active, 1) = 1;
    `);

  return Boolean(result.recordset?.[0]?.story_id);
}

export async function saveApprovedStory({
  authorId,
  sourceStoryId,
  persistedStoryId,
  title,
  subtitle = null,
  content,
  editorialPlan = null,
  timeline = [],
  memories = [],
  relationships = [],
  lineage = [],
  generationPayload = null,
  editorialMemoryOrigins = null,
  origin = null,
} = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeSourceStoryId = toPositiveInt(sourceStoryId);
  const safePersistedStoryId = toPositiveInt(persistedStoryId);
  const safeTitle = safeText(title, "História sem título").slice(0, 220);
  const safeSubtitle = safeText(subtitle, null)?.slice(0, 300) ?? null;
  const safeContent = safeText(content, "");
  const safeOrigin = safeText(origin || generationPayload?.origin, "DISCOVERED_BY_AI").toUpperCase() === "CREATED_BY_AUTHOR"
    ? "CREATED_BY_AUTHOR"
    : "DISCOVERED_BY_AI";

  if (!safeAuthorId) {
    return { ok: false, error: "authorId inválido." };
  }

  if (!safeContent || safeContent.length < 20) {
    return {
      ok: false,
      error: "A História precisa de conteúdo narrativo para ser salva.",
    };
  }

  const normalizedEditorialMemories = normalizeEditorialMemories(
    memories,
    editorialMemoryOrigins || generationPayload?.editorial_memory_origins || {}
  );
  const orderedEditorialMemories = normalizedEditorialMemories
    .map((memory, index) => ({ ...memory, narrative_order: memory.narrative_order || index + 1 }))
    .sort((a, b) => a.narrative_order - b.narrative_order);
  const memoryIds = [
    ...new Set(orderedEditorialMemories.map((memory) => memory.memory_id)),
  ];
  const editorialOrigins = Object.fromEntries(
    orderedEditorialMemories.map((memory) => [
      String(memory.memory_id),
      memory.editorial_origin,
    ])
  );

  if (!memoryIds.length) {
    return {
      ok: false,
      error: "A História precisa de ao menos uma memória aprovada.",
    };
  }

  const safeLineage = asArray(lineage).length
    ? asArray(lineage)
    : asArray(relationships);

  const normalizedGenerationPayload = normalizeGenerationPayload({
    ...(generationPayload || {}),
    editorial_plan:
      editorialPlan ?? generationPayload?.editorial_plan ?? null,
    lineage: safeLineage,
    selected_memory_ids: memoryIds,
    narrative_memory_order: orderedEditorialMemories.map((memory) => ({
      memory_id: memory.memory_id,
      order: memory.narrative_order,
    })),
    story_assets: orderedEditorialMemories
      .filter((memory) => memory.image_url || memory.media_id)
      .map((memory) => ({
        memory_id: memory.memory_id,
        media_id: memory.media_id || null,
        image_url: memory.image_url || null,
        display_order: memory.narrative_order,
      })),
    editorial_memory_origins: editorialOrigins,
    source_story_id: safeSourceStoryId,
    persisted_story_id: safePersistedStoryId,
    origin: safeOrigin,
    manuscript_preserved: true,
    regenerated: false,
  });

  const hypothesisId = safeText(
    normalizedGenerationPayload?.hypothesis_id,
    null
  );

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();

  let storyId = null;

  try {
    if (safeSourceStoryId) {
      const ownsCandidate = await assertStoryCandidateOwnership({
        tx,
        authorId: safeAuthorId,
        sourceStoryId: safeSourceStoryId,
      });

      if (!ownsCandidate) {
        await tx.rollback();
        return {
          ok: false,
          error: "Story Candidate não encontrada para este autor.",
        };
      }
    }

    if (safePersistedStoryId) {
      const existing = await tx.request()
        .input("story_id", sql.Int, safePersistedStoryId)
        .input("author_id", sql.Int, safeAuthorId)
        .query(`
          SELECT TOP 1 story_id
          FROM dbo.identity_story
          WHERE story_id = @story_id
            AND author_id = @author_id
            AND ISNULL(is_deleted, 0) = 0;
        `);
      if (!existing.recordset?.[0]) {
        await tx.rollback();
        return { ok: false, error: "História salva não encontrada para este autor." };
      }
      storyId = safePersistedStoryId;
      await tx.request()
        .input("story_id", sql.Int, storyId)
        .input("author_id", sql.Int, safeAuthorId)
        .input("title", sql.NVarChar(220), safeTitle)
        .input("subtitle", sql.NVarChar(300), safeSubtitle)
        .input("summary", sql.NVarChar(sql.MAX), safeContent)
        .input("story_key", sql.VarChar(180), hypothesisId?.slice(0, 180) ?? null)
        .input("memory_count", sql.Int, memoryIds.length)
        .input("chapter_lineage", sql.NVarChar(sql.MAX), safeJson(safeLineage, "[]"))
        .input("origin", sql.VarChar(30), safeOrigin)
        .query(`
          UPDATE dbo.identity_story
          SET title = @title,
              subtitle = @subtitle,
              summary = @summary,
              story_key = COALESCE(@story_key, story_key),
              memory_count = @memory_count,
              chapter_lineage = @chapter_lineage,
              origin = @origin,
              status = 'draft',
              consolidation_status = 'consolidated',
              updated_at = SYSUTCDATETIME(),
              last_consolidated_at = SYSUTCDATETIME()
          WHERE story_id = @story_id AND author_id = @author_id;

          DELETE FROM dbo.identity_story_timeline
          WHERE story_id = @story_id AND author_id = @author_id;
          DELETE FROM dbo.identity_story_memory
          WHERE story_id = @story_id AND author_id = @author_id;
        `);
    } else {
    const inserted = await tx
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("title", sql.NVarChar(220), safeTitle)
      .input("subtitle", sql.NVarChar(300), safeSubtitle)
      .input("summary", sql.NVarChar(sql.MAX), safeContent)
      .input("story_key", sql.VarChar(180), hypothesisId?.slice(0, 180) ?? null)
      .input("story_type", sql.VarChar(40), "manual")
      .input("status", sql.VarChar(20), "draft")
      .input("consolidation_status", sql.VarChar(30), "consolidated")
      .input("source_date_kind", sql.VarChar(30), "created_at")
      .input("memory_count", sql.Int, memoryIds.length)
      .input("chapter_lineage", sql.NVarChar(sql.MAX), safeJson(safeLineage, "[]"))
      .input("story_publication_status", sql.VarChar(40), "DRAFT")
      .input("origin", sql.VarChar(30), safeOrigin)
      .query(`
        INSERT INTO dbo.identity_story (
          author_id,
          title,
          subtitle,
          summary,
          story_key,
          story_type,
          status,
          consolidation_status,
          source_date_kind,
          memory_count,
          strength_score,
          confidence_score,
          chapter_lineage,
          story_publication_status,
          origin,
          is_deleted,
          created_at,
          updated_at,
          last_consolidated_at
        )
        OUTPUT INSERTED.story_id
        VALUES (
          @author_id,
          @title,
          @subtitle,
          @summary,
          @story_key,
          @story_type,
          @status,
          @consolidation_status,
          @source_date_kind,
          @memory_count,
          0,
          100,
          @chapter_lineage,
          @story_publication_status,
          @origin,
          0,
          SYSUTCDATETIME(),
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        );
      `);

    storyId = Number(inserted.recordset?.[0]?.story_id);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      throw new Error("A História foi criada sem identificador válido.");
    }

    }

    for (let index = 0; index < memoryIds.length; index += 1) {
      const memoryId = memoryIds[index];

      await tx
        .request()
        .input("story_id", sql.Int, storyId)
        .input("author_id", sql.Int, safeAuthorId)
        .input("memory_id", sql.Int, memoryId)
        .input("sort_order", sql.Int, index + 1)
        .input("is_anchor", sql.Bit, index === 0 ? 1 : 0)
        .query(`
          IF EXISTS (
            SELECT 1
            FROM dbo.identity_memory
            WHERE memory_id = @memory_id
              AND author_id = @author_id
              AND ISNULL(is_deleted, 0) = 0
          )
          BEGIN
            INSERT INTO dbo.identity_story_memory (
              story_id,
              author_id,
              memory_id,
              sort_order,
              story_role,
              link_strength,
              evidence_reason,
              timeline_at,
              source_date_kind,
              is_anchor,
              created_at,
              updated_at
            )
            VALUES (
              @story_id,
              @author_id,
              @memory_id,
              @sort_order,
              CASE WHEN @is_anchor = 1 THEN 'anchor' ELSE 'supporting' END,
              100,
              N'Memória selecionada e aprovada pelo autor para compor esta História.',
              SYSUTCDATETIME(),
              'created_at',
              @is_anchor,
              SYSUTCDATETIME(),
              SYSUTCDATETIME()
            );
          END
        `);
    }

    const timelineItems = asArray(timeline).map(normalizeTimelineItem);
    for (const item of timelineItems) {
      await tx
        .request()
        .input("story_id", sql.Int, storyId)
        .input("author_id", sql.Int, safeAuthorId)
        .input("memory_id", sql.Int, item.memory_id)
        .input("event_type", sql.VarChar(50), item.event_type)
        .input("event_title", sql.NVarChar(220), item.event_title)
        .input("event_description", sql.NVarChar(sql.MAX), item.event_description)
        .input("event_at", sql.DateTime2, item.event_at)
        .input("event_order", sql.Int, item.event_order)
        .input("source_date_kind", sql.VarChar(30), item.source_date_kind)
        .input("metadata_json", sql.NVarChar(sql.MAX), item.metadata_json)
        .query(`
          INSERT INTO dbo.identity_story_timeline (
            story_id,
            author_id,
            memory_id,
            event_type,
            event_title,
            event_description,
            event_at,
            event_order,
            source_date_kind,
            metadata_json,
            created_at
          )
          VALUES (
            @story_id,
            @author_id,
            @memory_id,
            @event_type,
            @event_title,
            @event_description,
            @event_at,
            @event_order,
            @source_date_kind,
            @metadata_json,
            SYSUTCDATETIME()
          );
        `);
    }

    if (safeSourceStoryId) {
      await tx
        .request()
        .input("author_id", sql.Int, safeAuthorId)
        .input("story_id", sql.Int, safeSourceStoryId)
        .query(`
          UPDATE dbo.identity_narrative_story
          SET
            story_status = CASE
              WHEN story_status IN ('DISCARDED', 'SNOOZED') THEN story_status
              ELSE 'ACCEPTED'
            END,
            accepted_at = COALESCE(accepted_at, SYSUTCDATETIME()),
            updated_at = SYSUTCDATETIME()
          WHERE story_id = @story_id
            AND author_id = @author_id;
        `);
    }

    await tx.commit();

    let initialVersion;
    if (safePersistedStoryId) {
      const previous = await pool.request()
        .input("story_id", sql.BigInt, storyId)
        .input("author_id", sql.BigInt, safeAuthorId)
        .query(`
          SELECT TOP 1 content, version_number
          FROM dbo.identity_story_version
          WHERE story_id = @story_id AND author_id = @author_id
          ORDER BY version_number DESC, story_version_id DESC;
        `);
      const previousContent = String(previous.recordset?.[0]?.content || "");
      const nextVersion = Number(previous.recordset?.[0]?.version_number || 0) + 1;
      const insertedVersion = await pool.request()
        .input("story_id", sql.BigInt, storyId)
        .input("author_id", sql.BigInt, safeAuthorId)
        .input("version_number", sql.Int, nextVersion)
        .input("title", sql.NVarChar(1000), safeTitle)
        .input("subtitle", sql.NVarChar(1000), safeSubtitle)
        .input("content", sql.NVarChar(sql.MAX), safeContent)
        .input("diff_json", sql.NVarChar(sql.MAX), safeJson({ before_length: previousContent.length, after_length: safeContent.length }))
        .input("change_summary", sql.NVarChar(2000), "Nova revisão aprovada pelo autor.")
        .input("source_type", sql.VarChar(40), "AUTHOR_REVISION")
        .input("payload_json", sql.NVarChar(sql.MAX), safeJson(normalizedGenerationPayload))
        .query(`
          INSERT INTO dbo.identity_story_version
          (story_id, author_id, version_number, title, subtitle, content, diff_json,
           change_summary, source_type, payload_json, created_at, updated_at)
          OUTPUT INSERTED.story_version_id, INSERTED.version_number
          VALUES
          (@story_id, @author_id, @version_number, @title, @subtitle, @content,
           @diff_json, @change_summary, @source_type, @payload_json,
           SYSUTCDATETIME(), SYSUTCDATETIME());
        `);
      initialVersion = {
        ok: true,
        story_version_id: Number(insertedVersion.recordset?.[0]?.story_version_id),
        version_number: Number(insertedVersion.recordset?.[0]?.version_number),
      };
    } else {
      initialVersion = await createInitialStoryVersion({
        authorId: safeAuthorId,
        storyId,
        title: safeTitle,
        subtitle: safeSubtitle,
        content: safeContent,
        payload: normalizedGenerationPayload,
      });
    }

    if (!initialVersion?.ok) {
      throw new Error(initialVersion?.error || "Falha ao versionar a História.");
    }

    return {
      ok: true,
      story_id: storyId,
      source_story_id: safeSourceStoryId,
      status: "DRAFT",
      publication_status: "DRAFT",
      memory_count: memoryIds.length,
      timeline_count: timelineItems.length,
      relationship_count: 0,
      version: {
        story_version_id: initialVersion.story_version_id,
        version_number: initialVersion.version_number,
      },
      saved_at: new Date().toISOString(),
      source_policy:
        "História persistida com o manuscrito exato aprovado pelo autor, sem nova geração por IA.",
    };
  } catch (error) {
    try {
      if (!tx._aborted) await tx.rollback();
    } catch {
      // rollback best effort
    }

    // Se a História principal foi gravada e a versão falhou após o commit,
    // removemos o registro incompleto para permitir nova tentativa limpa.
    if (storyId && !safePersistedStoryId) {
      try {
        await pool
          .request()
          .input("author_id", sql.Int, safeAuthorId)
          .input("story_id", sql.Int, storyId)
          .query(`
            DELETE FROM dbo.identity_story_timeline
            WHERE story_id = @story_id AND author_id = @author_id;

            DELETE FROM dbo.identity_story_memory
            WHERE story_id = @story_id AND author_id = @author_id;

            DELETE FROM dbo.identity_story
            WHERE story_id = @story_id AND author_id = @author_id;
          `);
      } catch {
        // limpeza best effort
      }
    }

    return {
      ok: false,
      error: error?.message || "Falha ao salvar História.",
    };
  }
}
