import { buildArcProgression, stageOrder } from './arc-progression.service.js';

function safeArray(value) { return Array.isArray(value) ? value : []; }
function safeText(value, fallback = null) { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t || fallback; }

function titleOf(candidate = {}, blueprint = {}) {
  return safeText(candidate.title || candidate.suggested_title || blueprint.title || blueprint.provisional_title, 'História em descoberta');
}

function groupStages(progression = []) {
  const grouped = Object.fromEntries(stageOrder().map((stage) => [stage, []]));
  for (const item of progression) grouped[item.dramatic_stage]?.push(item);
  return grouped;
}

function stageSummary(stage, items = []) {
  if (!items.length) return null;
  return {
    stage,
    label: ({ BEGINNING: 'início', DEVELOPMENT: 'desenvolvimento', TRANSFORMATION: 'transformação', CONSOLIDATION: 'consolidação', CONTINUITY: 'continuidade' })[stage],
    memory_ids: items.map((item) => item.memory_id).filter(Boolean),
    narrative_roles: [...new Set(items.map((item) => item.narrative_role).filter(Boolean))],
    first_position: items[0].position,
    last_position: items[items.length - 1].position,
  };
}

export function buildNarrativeArcDraft({ candidate = {}, blueprint = null, memories = null } = {}) {
  const sourceBlueprint = blueprint || candidate.story_blueprint || candidate.blueprint || {};
  const sourceMemories = safeArray(memories).length
    ? safeArray(memories)
    : safeArray(sourceBlueprint.used_memories).length
      ? safeArray(sourceBlueprint.used_memories)
      : safeArray(candidate.memories);

  const progression = buildArcProgression(sourceMemories);
  const grouped = groupStages(progression);
  const stages = stageOrder().map((stage) => stageSummary(stage, grouped[stage])).filter(Boolean);

  return {
    type: 'NARRATIVE_ARC',
    arc_id: `${candidate.candidate_id || candidate.story_id || 'runtime'}:arc`,
    title: titleOf(candidate, sourceBlueprint),
    central_question: sourceBlueprint.central_question || candidate.central_question || null,
    transformation: sourceBlueprint.transformation || candidate.transformation || null,
    progression,
    stages,
    stage_sequence: stages.map((stage) => stage.stage),
    narrative_roles: progression.map((item) => item.narrative_role),
    memory_ids: progression.map((item) => item.memory_id).filter(Boolean),
    source_blueprint_status: sourceBlueprint.status || null,
    runtime_persistence: {
      mode: 'IN_MEMORY',
      persisted: false,
      generated_at: new Date().toISOString(),
    },
  };
}
