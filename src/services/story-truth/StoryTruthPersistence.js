import { sql } from '../../db.js';
import { listAuthorActiveStories } from '../story/story-lifecycle.service.js';

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeStoryId(row) {
  return toPositiveInt(row?.story_id ?? row?.id ?? row?.narrative_story_id ?? row?.candidate_id);
}

function normalizeStoryList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.stories)) return payload.stories;
  if (Array.isArray(payload?.candidates)) return payload.candidates;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function storyTitle(story, fallbackStoryId) {
  return String(
    story?.title ||
    story?.suggested_title ||
    story?.name ||
    story?.central_theme ||
    story?.dominant_theme ||
    `História ${fallbackStoryId}`
  ).trim();
}

function storySummary(story) {
  return String(
    story?.one_line_summary ||
    story?.summary ||
    story?.description ||
    story?.central_theme ||
    story?.dominant_theme ||
    'História descoberta a partir das memórias do autor.'
  ).trim();
}

export class StoryTruthPersistence {
  constructor(pool) {
    if (!pool) throw new Error('StoryTruthPersistence requires a SQL pool');
    this.pool = pool;
  }

  async loadCandidate({ storyId, authorId }) {
    const payload = await listAuthorActiveStories({
      authorId,
      limit: 200,
      includeSnoozed: true,
    });

    const stories = normalizeStoryList(payload);
    const found = stories.find((item) => normalizeStoryId(item) === Number(storyId));

    if (!found) return null;

    return {
      ...found,
      story_id: Number(storyId),
      candidate_id: Number(storyId),
      title: storyTitle(found, storyId),
      summary: storySummary(found),
      status: found.status || found.story_status || 'DISCOVERED',
      created_at: found.created_at || new Date().toISOString(),
    };
  }

  async loadMemories({ storyId, authorId }) {
    const result = await this.pool.request()
      .input('story_id', sql.BigInt, Number(storyId))
      .input('author_id', sql.BigInt, Number(authorId))
      .query(`
        SELECT DISTINCT
          m.memory_id,
          m.title,
          m.content,
          COALESCE(m.published_at, m.created_at) AS memory_date,
          m.created_at,
          m.published_at,
          m.phase_id
        FROM dbo.identity_narrative_story_memory sm
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = sm.memory_id
         AND m.author_id = sm.author_id
        WHERE sm.story_id = @story_id
          AND sm.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0
        ORDER BY COALESCE(m.published_at, m.created_at) ASC, m.memory_id ASC;
      `);

    return result.recordset || [];
  }

  async loadPreviousVersions({ storyId, authorId }) {
    const tableCheck = await this.pool.request().query(`
      SELECT CASE WHEN OBJECT_ID('dbo.identity_story_version', 'U') IS NULL THEN 0 ELSE 1 END AS exists_table;
    `);

    if (!Number(tableCheck.recordset?.[0]?.exists_table)) return [];

    const result = await this.pool.request()
      .input('story_id', sql.Int, Number(storyId))
      .input('author_id', sql.Int, Number(authorId))
      .query(`
        SELECT TOP 10
          story_version_id,
          story_id,
          content,
          created_at
        FROM dbo.identity_story_version
        WHERE story_id = @story_id
          AND author_id = @author_id
        ORDER BY story_version_id DESC;
      `);

    return result.recordset || [];
  }

  async saveVersion({ context }) {
    const manuscript = context.manuscript || '';

    const result = await this.pool.request()
      .input('story_id', sql.Int, context.storyId)
      .input('author_id', sql.Int, context.authorId)
      .input('content', sql.NVarChar(sql.MAX), manuscript)
      .input('truth_score', sql.Int, context.truthReport?.truth_score || 0)
      .input('evidence_quality', sql.VarChar(20), context.truthReport?.evidence_quality || 'NONE')
      .input('hallucination_risk', sql.VarChar(20), context.truthReport?.hallucination_risk || 'MEDIUM')
      .query(`
        INSERT INTO dbo.identity_story_version
        (
          story_id,
          author_id,
          content,
          truth_score,
          evidence_quality,
          hallucination_risk,
          created_at
        )
        OUTPUT INSERTED.story_version_id
        VALUES
        (
          @story_id,
          @author_id,
          @content,
          @truth_score,
          @evidence_quality,
          @hallucination_risk,
          SYSUTCDATETIME()
        );
      `);

    context.version = {
      story_version_id: result.recordset?.[0]?.story_version_id || null,
      story_id: context.storyId,
      author_id: context.authorId,
      truth_score: context.truthReport?.truth_score || 0,
      evidence_quality: context.truthReport?.evidence_quality || 'NONE',
      hallucination_risk: context.truthReport?.hallucination_risk || 'MEDIUM',
    };

    return context;
  }

  async saveTruthReport({ context }) {
    await this.pool.request()
      .input('story_id', sql.Int, context.storyId)
      .input('author_id', sql.Int, context.authorId)
      .input('truth_score', sql.Int, context.truthReport?.truth_score || 0)
      .input('evidence_quality', sql.VarChar(20), context.truthReport?.evidence_quality || 'NONE')
      .input('hallucination_risk', sql.VarChar(20), context.truthReport?.hallucination_risk || 'MEDIUM')
      .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(context.truthReport || {}))
      .query(`
        INSERT INTO dbo.identity_story_truth
        (
          story_id,
          author_id,
          truth_score,
          evidence_quality,
          hallucination_risk,
          payload_json,
          created_at
        )
        VALUES
        (
          @story_id,
          @author_id,
          @truth_score,
          @evidence_quality,
          @hallucination_risk,
          @payload_json,
          SYSUTCDATETIME()
        );
      `);

    return context;
  }

  async saveLineage({ context }) {
    if (!context.lineage) return context;

    await this.pool.request()
      .input('story_id', sql.Int, context.storyId)
      .input('author_id', sql.Int, context.authorId)
      .input('version_id', sql.Int, context.version?.story_version_id || null)
      .input('previous_version_id', sql.Int, context.lineage?.previous_version_id || null)
      .input('lineage_json', sql.NVarChar(sql.MAX), JSON.stringify(context.lineage))
      .query(`
        INSERT INTO dbo.identity_story_lineage
        (
          story_id,
          author_id,
          version_id,
          previous_version_id,
          lineage_json,
          created_at
        )
        VALUES
        (
          @story_id,
          @author_id,
          @version_id,
          @previous_version_id,
          @lineage_json,
          SYSUTCDATETIME()
        );
      `);

    return context;
  }

  async saveValidation({ context }) {
    await this.pool.request()
      .input('story_id', sql.Int, context.storyId)
      .input('author_id', sql.Int, context.authorId)
      .input('version_id', sql.Int, context.version?.story_version_id || null)
      .input('validation_status', sql.VarChar(20), context.validation?.status || 'WARNING')
      .input('truth_score', sql.Int, context.validation?.truth_score || 0)
      .input('hallucination_risk', sql.VarChar(20), context.validation?.hallucination_risk || 'MEDIUM')
      .input('validation_json', sql.NVarChar(sql.MAX), JSON.stringify(context.validation || {}))
      .query(`
        INSERT INTO dbo.identity_story_truth_validation
        (
          story_id,
          author_id,
          version_id,
          validation_status,
          truth_score,
          hallucination_risk,
          validation_json,
          created_at
        )
        VALUES
        (
          @story_id,
          @author_id,
          @version_id,
          @validation_status,
          @truth_score,
          @hallucination_risk,
          @validation_json,
          SYSUTCDATETIME()
        );
      `);

    return context;
  }

  async saveAll({ context }) {
    await this.saveVersion({ context });
    await this.saveTruthReport({ context });
    await this.saveLineage({ context });
    await this.saveValidation({ context });
    return context;
  }
}
