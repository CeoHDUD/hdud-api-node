// C:\HDUD_DATA\hdud-api-node\src\services\stories\story-lineage-timeline.service.js

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildLineageTimeline(storyTimeline = {}) {
  const events = safeArray(storyTimeline.ordered_events);
  const paragraphTimelines = safeArray(storyTimeline.paragraph_timelines);

  return events.map((event, index) => {
    const paragraphs = paragraphTimelines.filter((paragraph) =>
      safeArray(paragraph.timeline).some((item) => item.memory_id === event.memory_id)
    );

    return {
      lineage_id: `lineage_timeline_${index + 1}`,
      memory_id: event.memory_id,
      memory_title: event.title,
      memory_date: event.memory_date,
      phase: event.phase,
      narrative_position: index + 1,
      used_by_paragraphs: paragraphs.map((paragraph) => ({
        paragraph_id: paragraph.paragraph_id,
        paragraph_order: paragraph.paragraph_order,
        truth_score: paragraph.truth_score,
        evidence_quality: paragraph.evidence_quality,
        hallucination_risk: paragraph.hallucination_risk
      })),
      lineage: {
        source: 'identity_memory',
        transformation: 'memory -> truth_selection -> evidence_map -> truth_timeline',
        auditability: paragraphs.length > 0 ? 'traceable' : 'weak',
        support_level: event.roles?.includes('primary') ? 'primary' : 'support'
      }
    };
  });
}

export default {
  buildLineageTimeline
};
