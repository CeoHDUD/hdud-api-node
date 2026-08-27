// C:\HDUD_DATA\hdud-api-node\src\services\stories\story-truth-timeline.service.js

import { getPool, sql } from '../../db.js';
import { buildStoryTruthTimeline } from './story-timeline-builder.service.js';
import { buildLineageTimeline } from './story-lineage-timeline.service.js';

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}


async function getLatestStoryVersion(storyId, authorId) {
  const pool = await getPool();
  const request = pool.request()
    .input('story_id', sql.Int, Number(storyId))
    .input('author_id', sql.Int, Number(authorId));

  const result = await request.query(`
    SELECT TOP 1
      sv.*,
      s.story_id,
      s.author_id,
      s.title AS story_title
    FROM identity_story_version sv
    INNER JOIN identity_story s ON s.story_id = sv.story_id
    WHERE sv.story_id = @story_id
      AND s.author_id = @author_id
    ORDER BY sv.created_at DESC, sv.story_version_id DESC
  `);

  return result.recordset?.[0] || null;
}

async function getStoryMemories(storyId, authorId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('story_id', sql.Int, Number(storyId))
    .input('author_id', sql.Int, Number(authorId))
    .query(`
      SELECT DISTINCT
        m.memory_id,
        m.title,
        m.content,
        m.memory_date,
        m.created_at,
        m.published_at,
        p.name AS phase_name,
        p.code AS phase_code
      FROM identity_story_memory sm
      INNER JOIN identity_memory m ON m.memory_id = sm.memory_id
      LEFT JOIN identity_phase p ON p.phase_id = m.phase_id
      WHERE sm.story_id = @story_id
        AND m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
    `);

  return result.recordset || [];
}

async function persistStoryTimeline(storyVersionId, timeline) {
  if (!storyVersionId) return;

  const pool = await getPool();
  await pool.request()
    .input('story_version_id', sql.Int, Number(storyVersionId))
    .input('story_timeline', sql.NVarChar(sql.MAX), JSON.stringify(timeline))
    .input('chronology_score', sql.Int, Number(timeline.chronology_score || 0))
    .input('temporal_confidence', sql.Decimal(5, 2), Number(timeline.temporal_confidence || 0))
    .input('turning_points', sql.NVarChar(sql.MAX), JSON.stringify(timeline.turning_points || []))
    .input('narrative_gaps', sql.NVarChar(sql.MAX), JSON.stringify(timeline.narrative_gaps || []))
    .query(`
      UPDATE identity_story_version
      SET
        story_timeline = @story_timeline,
        chronology_score = @chronology_score,
        temporal_confidence = @temporal_confidence,
        turning_points = @turning_points,
        narrative_gaps = @narrative_gaps,
        updated_at = SYSUTCDATETIME()
      WHERE story_version_id = @story_version_id
    `);
}

export async function getStoryTruthTimeline({ storyId, authorId, rebuild = false }) {
  const version = await getLatestStoryVersion(storyId, authorId);
  if (!version) {
    const error = new Error('Story não encontrada ou sem versão editorial.');
    error.statusCode = 404;
    throw error;
  }

  const persistedTimeline = safeJsonParse(version.story_timeline, null);
  if (persistedTimeline && !rebuild) {
    return {
      story_id: Number(storyId),
      story_version_id: Number(version.story_version_id),
      chronology_score: Number(version.chronology_score || persistedTimeline.chronology_score || 0),
      temporal_confidence: Number(version.temporal_confidence || persistedTimeline.temporal_confidence || 0),
      events: persistedTimeline.ordered_events || persistedTimeline.events || [],
      ordered_events: persistedTimeline.ordered_events || persistedTimeline.events || [],
      paragraph_timelines: persistedTimeline.paragraph_timelines || [],
      turning_points: safeJsonParse(version.turning_points, persistedTimeline.turning_points || []),
      gaps: safeJsonParse(version.narrative_gaps, persistedTimeline.narrative_gaps || []),
      narrative_gaps: safeJsonParse(version.narrative_gaps, persistedTimeline.narrative_gaps || []),
      lineage_timeline: persistedTimeline.lineage_timeline || buildLineageTimeline(persistedTimeline),
      generated_at: persistedTimeline.generated_at || null,
      source: 'persisted'
    };
  }

  const memories = await getStoryMemories(storyId, authorId);
  const timeline = buildStoryTruthTimeline({ version, memories });
  timeline.story_id = Number(storyId);
  timeline.story_version_id = Number(version.story_version_id);
  timeline.lineage_timeline = buildLineageTimeline(timeline);

  await persistStoryTimeline(version.story_version_id, timeline);

  return {
    story_id: Number(storyId),
    story_version_id: Number(version.story_version_id),
    chronology_score: timeline.chronology_score,
    temporal_confidence: timeline.temporal_confidence,
    events: timeline.ordered_events,
    ordered_events: timeline.ordered_events,
    paragraph_timelines: timeline.paragraph_timelines,
    turning_points: timeline.turning_points,
    gaps: timeline.narrative_gaps,
    narrative_gaps: timeline.narrative_gaps,
    lineage_timeline: timeline.lineage_timeline,
    generated_at: timeline.generated_at,
    source: 'rebuilt'
  };
}

export default {
  getStoryTruthTimeline
};
