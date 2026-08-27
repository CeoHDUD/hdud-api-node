const STOP_WORDS = new Set([
  'A', 'O', 'AS', 'OS', 'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'NO', 'NA', 'NOS', 'NAS',
  'UM', 'UMA', 'UNS', 'UMAS', 'PARA', 'POR', 'COM', 'SEM', 'QUE', 'COMO', 'QUANDO', 'ONDE',
  'THE', 'OF', 'AND', 'IN', 'ON', 'TO', 'FOR', 'WITH', 'WITHOUT', 'MY', 'OUR',
]);

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function safeText(value, fallback = null) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

export function token(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function unique(values = []) {
  return [...new Set(safeArray(values).filter((value) => value !== null && value !== undefined && value !== ''))];
}

export function numericId(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

export function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

export function setIntersection(left = [], right = []) {
  const rightSet = new Set(safeArray(right));
  return unique(safeArray(left).filter((value) => rightSet.has(value)));
}

export function jaccard(left = [], right = []) {
  const a = new Set(safeArray(left));
  const b = new Set(safeArray(right));
  if (!a.size && !b.size) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function textTokens(...values) {
  return unique(
    values
      .filter(Boolean)
      .flatMap((value) => String(value).split(/[^\p{L}\p{N}]+/u))
      .map(token)
      .filter((value) => value && value.length >= 3 && !STOP_WORDS.has(value)),
  );
}

export function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateRange(items = []) {
  const dates = safeArray(items)
    .map((item) => parseDate(item?.date ?? item?.memory_date ?? item?.narrative_date ?? item?.created_at))
    .filter(Boolean)
    .sort((a, b) => a - b);

  return {
    start: dates[0]?.toISOString() || null,
    end: dates[dates.length - 1]?.toISOString() || null,
  };
}

export function daysBetween(left, right) {
  const a = parseDate(left);
  const b = parseDate(right);
  if (!a || !b) return null;
  return Math.abs(b.getTime() - a.getTime()) / 86400000;
}

export function arcIdOf(arc = {}, index = 0) {
  return safeText(arc.arc_id || arc.id || arc.story_id || arc.candidate_id, `runtime:arc:${index + 1}`);
}

export function memoryIdOf(memory = {}) {
  return numericId(memory.memory_id ?? memory.id ?? memory.memoryId);
}

export function candidateForArc(arc = {}, candidates = [], index = 0) {
  const arcId = arcIdOf(arc, index);
  const baseId = arcId.replace(/:arc$/, '');
  return safeArray(candidates).find((candidate) => {
    const ids = [candidate.candidate_id, candidate.story_id, candidate.id]
      .map((value) => safeText(value))
      .filter(Boolean);
    return ids.includes(baseId) || ids.includes(arcId) || candidate.narrative_arc === arc;
  }) || safeArray(candidates)[index] || {};
}

export function buildArcDescriptor(arc = {}, candidate = {}, index = 0) {
  const progression = safeArray(arc.progression);
  const candidateMemories = safeArray(candidate.memories || candidate.used_memories || candidate.story_blueprint?.used_memories);
  const memoryIds = unique([
    ...safeArray(arc.memory_ids).map(numericId),
    ...progression.map((item) => numericId(item.memory_id)),
    ...candidateMemories.map(memoryIdOf),
  ].filter(Boolean));

  const lifePeriods = unique(candidateMemories.map((memory) => token(memory.life_period_code || memory.editorial?.life_period_code)).filter(Boolean));
  const contexts = unique(candidateMemories.map((memory) => token(memory.context_code || memory.editorial?.context_code)).filter(Boolean));
  const roles = unique([
    ...safeArray(arc.narrative_roles).map(token),
    ...progression.map((item) => token(item.narrative_role)),
    ...candidateMemories.map((memory) => token(memory.narrative_role_code || memory.editorial?.narrative_role_code)),
  ].filter(Boolean));
  const stages = unique([
    ...safeArray(arc.stage_sequence).map(token),
    ...progression.map((item) => token(item.dramatic_stage)),
  ].filter(Boolean));
  const canonicalKeys = unique(candidateMemories.map((memory) => token(memory.canonical_story_key)).filter(Boolean));
  const range = dateRange(progression.length ? progression : candidateMemories);
  const title = safeText(arc.title || candidate.title || candidate.suggested_title, `Arco ${index + 1}`);
  const centralQuestion = safeText(arc.central_question || candidate.central_question || candidate.story_blueprint?.central_question);
  const transformation = safeText(arc.transformation || candidate.transformation || candidate.story_blueprint?.transformation);

  return {
    arc_id: arcIdOf(arc, index),
    index,
    title,
    central_question: centralQuestion,
    transformation,
    status: arc.status || null,
    can_proceed_to_truth: Boolean(arc.can_proceed_to_truth),
    completion_score: Number(arc.completion?.completion_score || 0),
    arc_score: Number(arc.scoring?.overall_arc_score || candidate.arc_score || 0),
    memory_ids: memoryIds,
    life_periods: lifePeriods,
    contexts,
    narrative_roles: roles,
    dramatic_stages: stages,
    canonical_story_keys: canonicalKeys,
    text_tokens: textTokens(title, centralQuestion, transformation, candidate.narrative_hypothesis),
    date_range: range,
    source_arc: arc,
  };
}
