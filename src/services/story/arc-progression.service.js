const STAGE_ORDER = Object.freeze([
  'BEGINNING',
  'DEVELOPMENT',
  'TRANSFORMATION',
  'CONSOLIDATION',
  'CONTINUITY',
]);

const ROLE_STAGE = Object.freeze({
  BIRTH: 'BEGINNING', ORIGIN: 'BEGINNING', BACKGROUND: 'BEGINNING', SETUP: 'BEGINNING',
  RELATIONSHIP: 'DEVELOPMENT', LOVE: 'DEVELOPMENT', DISCOVERY: 'DEVELOPMENT', INCITING_EVENT: 'DEVELOPMENT',
  CONFLICT: 'TRANSFORMATION', CRISIS: 'TRANSFORMATION', TRANSFORMATION: 'TRANSFORMATION', TURNING_POINT: 'TRANSFORMATION',
  CLIMAX: 'CONSOLIDATION', MARRIAGE: 'CONSOLIDATION', RESOLUTION: 'CONSOLIDATION', CONSEQUENCE: 'CONSOLIDATION', PATERNITY: 'CONSOLIDATION', MATERNITY: 'CONSOLIDATION', CHILD_BIRTH: 'CONSOLIDATION',
  CONTINUITY: 'CONTINUITY', LEGACY: 'CONTINUITY', FUTURE: 'CONTINUITY', RECONCILIATION: 'CONTINUITY',
});

function token(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function narrativeRoleOf(memory = {}) {
  const candidates = [
    memory.narrative_role_code,
    memory.narrative_arc_code,
    memory.role_code,
    memory.story_role,
    memory.editorial?.narrative_role_code,
    memory.editorial?.narrative_arc_code,
    memory.narrative_path?.narrative_role_code,
    memory.narrative_path?.role_code,
  ];
  for (const value of candidates) {
    const normalized = token(value);
    if (normalized) return normalized;
  }
  return 'UNCLASSIFIED';
}

export function stageForRole(role, index = 0, total = 1) {
  const normalized = token(role);
  if (ROLE_STAGE[normalized]) return ROLE_STAGE[normalized];
  if (total <= 1 || index === 0) return 'BEGINNING';
  if (index === total - 1) return 'CONTINUITY';
  const ratio = index / Math.max(1, total - 1);
  if (ratio < 0.35) return 'DEVELOPMENT';
  if (ratio < 0.7) return 'TRANSFORMATION';
  return 'CONSOLIDATION';
}

export function buildArcProgression(memories = []) {
  const items = Array.isArray(memories) ? memories : [];
  return items.map((memory, index) => {
    const role = narrativeRoleOf(memory);
    const stage = stageForRole(role, index, items.length);
    return {
      position: index + 1,
      memory_id: Number(memory.memory_id ?? memory.id ?? memory.memoryId) || null,
      title: memory.title || memory.memory_title || `Memória ${index + 1}`,
      date: memory.memory_date ?? memory.narrative_date ?? memory.created_at ?? null,
      narrative_role: role,
      dramatic_stage: stage,
      stage_order: STAGE_ORDER.indexOf(stage) + 1,
      source: role === 'UNCLASSIFIED' ? 'POSITIONAL_FALLBACK' : 'AUTHOR_NTG_CLASSIFICATION',
    };
  });
}

export function stageOrder() {
  return [...STAGE_ORDER];
}
