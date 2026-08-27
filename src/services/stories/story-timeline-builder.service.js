// C:\HDUD_DATA\hdud-api-node\src\services\stories\story-timeline-builder.service.js

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizePhase(row) {
  return (
    row.phase_name ||
    row.phase_title ||
    row.phase_code ||
    row.life_phase ||
    row.phase ||
    'Sem fase definida'
  );
}

function normalizeEvidenceMap(version) {
  return safeJsonParse(
    version?.evidence_map || version?.evidenceMap || version?.evidence || version?.paragraph_evidence,
    []
  );
}

function normalizeParagraphScores(version) {
  return safeJsonParse(
    version?.paragraph_scores || version?.paragraphScores || version?.scores,
    []
  );
}

function buildMemoryIndex(memories = []) {
  const index = new Map();
  for (const row of memories) {
    const id = toNumber(row.memory_id ?? row.id, null);
    if (!id) continue;
    index.set(id, {
      memory_id: id,
      title: row.title || row.memory_title || `Memória ${id}`,
      content: row.content || row.memory_content || '',
      memory_date: normalizeDate(row.memory_date || row.narrative_date || row.created_at || row.published_at),
      phase: normalizePhase(row),
      created_at: row.created_at || null,
      published_at: row.published_at || null
    });
  }
  return index;
}

function buildParagraphTimeline({ evidenceMap = [], paragraphScores = [], memories = [] }) {
  const memoryIndex = buildMemoryIndex(memories);
  const scoreIndex = new Map();

  for (const score of Array.isArray(paragraphScores) ? paragraphScores : []) {
    const key = score.paragraph_id || score.paragraphId || String(score.paragraph_order || score.order || '');
    if (key) scoreIndex.set(String(key), score);
  }

  return (Array.isArray(evidenceMap) ? evidenceMap : []).map((paragraph, idx) => {
    const paragraphId = paragraph.paragraph_id || paragraph.paragraphId || `p_${idx + 1}`;
    const paragraphOrder = toNumber(paragraph.paragraph_order || paragraph.order, idx + 1);
    const sourceMemories = Array.isArray(paragraph.source_memories)
      ? paragraph.source_memories
      : Array.isArray(paragraph.memories)
        ? paragraph.memories
        : [];

    const timeline = sourceMemories
      .map((source, sourceIndex) => {
        const memoryId = toNumber(source.memory_id || source.id, null);
        const memory = memoryId ? memoryIndex.get(memoryId) : null;
        return {
          memory_id: memoryId,
          title: source.title || memory?.title || `Memória ${memoryId || sourceIndex + 1}`,
          memory_date: normalizeDate(source.memory_date || source.date || memory?.memory_date),
          phase: source.phase || source.phase_name || memory?.phase || 'Sem fase definida',
          event_type: source.event_type || (sourceIndex === 0 ? 'primary' : 'support'),
          evidence_role: source.evidence_role || source.role || (sourceIndex === 0 ? 'base' : 'support'),
          confidence: toNumber(source.confidence || source.score || paragraph.truth_score || 0, 0)
        };
      })
      .filter((event) => event.memory_id || event.title)
      .sort((a, b) => {
        if (!a.memory_date && !b.memory_date) return 0;
        if (!a.memory_date) return 1;
        if (!b.memory_date) return -1;
        return a.memory_date.localeCompare(b.memory_date);
      });

    const paragraphScore = scoreIndex.get(String(paragraphId)) || scoreIndex.get(String(paragraphOrder)) || {};

    return {
      paragraph_id: paragraphId,
      paragraph_order: paragraphOrder,
      paragraph: paragraph.paragraph || paragraph.text || '',
      truth_score: toNumber(paragraph.truth_score ?? paragraphScore.truth_score, 0),
      evidence_quality: paragraph.evidence_quality || paragraphScore.evidence_quality || 'unknown',
      hallucination_risk: paragraph.hallucination_risk || paragraphScore.hallucination_risk || 'unknown',
      timeline
    };
  });
}

function buildConsolidatedEvents(paragraphTimelines = []) {
  const eventIndex = new Map();

  for (const paragraph of paragraphTimelines) {
    for (const event of paragraph.timeline || []) {
      const key = event.memory_id ? `memory:${event.memory_id}` : `${event.title}:${event.memory_date || 'undated'}`;
      const existing = eventIndex.get(key);
      if (existing) {
        existing.paragraph_ids.push(paragraph.paragraph_id);
        existing.paragraph_orders.push(paragraph.paragraph_order);
        existing.roles = Array.from(new Set([...existing.roles, event.event_type]));
        existing.confidence = Math.max(existing.confidence, toNumber(event.confidence, 0));
      } else {
        eventIndex.set(key, {
          memory_id: event.memory_id,
          title: event.title,
          memory_date: event.memory_date,
          phase: event.phase,
          event_type: event.event_type,
          roles: [event.event_type],
          confidence: toNumber(event.confidence, 0),
          paragraph_ids: [paragraph.paragraph_id],
          paragraph_orders: [paragraph.paragraph_order]
        });
      }
    }
  }

  return Array.from(eventIndex.values()).sort((a, b) => {
    if (!a.memory_date && !b.memory_date) return a.title.localeCompare(b.title);
    if (!a.memory_date) return 1;
    if (!b.memory_date) return -1;
    return a.memory_date.localeCompare(b.memory_date);
  });
}

function detectNarrativeGaps(events = []) {
  const datedEvents = events.filter((event) => event.memory_date);
  const gaps = [];

  for (let i = 1; i < datedEvents.length; i += 1) {
    const previous = datedEvents[i - 1];
    const current = datedEvents[i];
    const previousDate = new Date(previous.memory_date);
    const currentDate = new Date(current.memory_date);
    const diffDays = Math.round((currentDate - previousDate) / (1000 * 60 * 60 * 24));

    if (diffDays > 365) {
      gaps.push({
        from_memory_id: previous.memory_id,
        to_memory_id: current.memory_id,
        from_date: previous.memory_date,
        to_date: current.memory_date,
        gap_days: diffDays,
        gap_years: Math.round((diffDays / 365) * 10) / 10,
        severity: diffDays > 1825 ? 'high' : diffDays > 730 ? 'medium' : 'low'
      });
    }
  }

  return gaps;
}

function detectTurningPoints(events = []) {
  return events
    .filter((event) => event.roles?.includes('primary') || toNumber(event.confidence, 0) >= 80)
    .slice(0, 12)
    .map((event, index) => ({
      turning_point_id: `tp_${index + 1}`,
      memory_id: event.memory_id,
      title: event.title,
      memory_date: event.memory_date,
      phase: event.phase,
      confidence: event.confidence,
      reason: event.roles?.includes('primary') ? 'Evidência primária de parágrafo' : 'Alta confiança documental'
    }));
}

function calculateTemporalConfidence(events = []) {
  if (!events.length) return 0;
  const dated = events.filter((event) => event.memory_date).length;
  return Math.round((dated / events.length) * 100) / 100;
}

function calculateChronologyScore(events = [], gaps = []) {
  if (!events.length) return 0;
  const datedRatio = calculateTemporalConfidence(events);
  const gapPenalty = Math.min(35, gaps.reduce((acc, gap) => acc + (gap.severity === 'high' ? 12 : gap.severity === 'medium' ? 7 : 3), 0));
  return Math.max(0, Math.round(datedRatio * 100 - gapPenalty));
}

export function buildStoryTruthTimeline({ version = {}, memories = [] } = {}) {
  const evidenceMap = normalizeEvidenceMap(version);
  const paragraphScores = normalizeParagraphScores(version);
  const paragraph_timelines = buildParagraphTimeline({ evidenceMap, paragraphScores, memories });
  const ordered_events = buildConsolidatedEvents(paragraph_timelines);
  const narrative_gaps = detectNarrativeGaps(ordered_events);
  const turning_points = detectTurningPoints(ordered_events);
  const temporal_confidence = calculateTemporalConfidence(ordered_events);
  const chronology_score = calculateChronologyScore(ordered_events, narrative_gaps);

  return {
    story_id: toNumber(version.story_id || version.id, null),
    story_version_id: toNumber(version.story_version_id || version.version_id, null),
    chronology_score,
    temporal_confidence,
    ordered_events,
    paragraph_timelines,
    turning_points,
    narrative_gaps,
    generated_at: new Date().toISOString()
  };
}

export default {
  buildStoryTruthTimeline
};
