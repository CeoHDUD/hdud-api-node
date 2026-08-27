// C:\HDUD_DATA\hdud-api-node\src\services\story\story-evidence-repository.sql.service.js

import sql from 'mssql';
import { getPool } from '../../db.js';

function json(value) {
  return JSON.stringify(value ?? null);
}

export async function saveStoryEvidenceMap({
  storyId,
  authorId,
  versionId = null,
  manuscript = '',
  evidenceMap = [],
  evidenceQuality = null,
  lineage = {},
  paragraphScores = [],
  sourceEngine = 'story-evidence-map-engine',
  sourceVersion = 'go-live-004.6',
} = {}) {
  if (!storyId) throw new Error('storyId is required');
  if (!authorId) throw new Error('authorId is required');

  const pool = await getPool();
  const request = pool.request();
  request.input('story_id', sql.BigInt, storyId);
  request.input('author_id', sql.BigInt, authorId);
  request.input('version_id', sql.BigInt, versionId);
  request.input('manuscript', sql.NVarChar(sql.MAX), manuscript);
  request.input('evidence_map', sql.NVarChar(sql.MAX), json(evidenceMap));
  request.input('evidence_quality', sql.VarChar(40), evidenceQuality);
  request.input('lineage', sql.NVarChar(sql.MAX), json(lineage));
  request.input('paragraph_scores', sql.NVarChar(sql.MAX), json(paragraphScores));
  request.input('source_engine', sql.VarChar(120), sourceEngine);
  request.input('source_version', sql.VarChar(120), sourceVersion);

  const result = await request.query(`
    IF OBJECT_ID('dbo.identity_narrative_story_version', 'U') IS NULL
    BEGIN
      THROW 51046, 'Tabela dbo.identity_narrative_story_version não existe. Execute 004_6_story_evidence_map.sql antes.', 1;
    END;

    INSERT INTO dbo.identity_narrative_story_version
      (story_id, author_id, manuscript, evidence_map_json, evidence_quality, lineage_json, paragraph_scores_json, source_engine, source_version, created_at)
    OUTPUT INSERTED.story_version_id AS story_version_id
    VALUES
      (@story_id, @author_id, @manuscript, @evidence_map, @evidence_quality, @lineage, @paragraph_scores, @source_engine, @source_version, SYSUTCDATETIME());
  `);

  return result.recordset?.[0] ?? null;
}

export async function getLatestStoryEvidenceMap({ storyId, authorId } = {}) {
  if (!storyId) throw new Error('storyId is required');
  if (!authorId) throw new Error('authorId is required');

  const pool = await getPool();
  const request = pool.request();
  request.input('story_id', sql.BigInt, storyId);
  request.input('author_id', sql.BigInt, authorId);

  const result = await request.query(`
    IF OBJECT_ID('dbo.identity_narrative_story_version', 'U') IS NULL
    BEGIN
      SELECT CAST(NULL AS bigint) AS story_version_id WHERE 1 = 0;
      RETURN;
    END;

    SELECT TOP 1
      story_version_id,
      story_id,
      author_id,
      manuscript,
      evidence_map_json,
      evidence_quality,
      lineage_json,
      paragraph_scores_json,
      source_engine,
      source_version,
      created_at
    FROM dbo.identity_narrative_story_version
    WHERE story_id = @story_id
      AND author_id = @author_id
    ORDER BY story_version_id DESC;
  `);

  const row = result.recordset?.[0];
  if (!row) return null;

  return {
    story_version_id: row.story_version_id,
    story_id: row.story_id,
    author_id: row.author_id,
    manuscript: row.manuscript,
    evidence_map: safeParse(row.evidence_map_json, []),
    evidence_quality: row.evidence_quality,
    lineage: safeParse(row.lineage_json, null),
    paragraph_scores: safeParse(row.paragraph_scores_json, []),
    source_engine: row.source_engine,
    source_version: row.source_version,
    created_at: row.created_at,
  };
}

function safeParse(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export default {
  saveStoryEvidenceMap,
  getLatestStoryEvidenceMap,
};
