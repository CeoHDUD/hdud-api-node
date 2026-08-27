import { stageOrder } from './arc-progression.service.js';

function safeArray(value) { return Array.isArray(value) ? value : []; }

export function validateNarrativeArc(arc = {}) {
  const progression = safeArray(arc.progression);
  const order = stageOrder();
  const violations = [];
  let previous = 0;

  progression.forEach((item) => {
    const current = order.indexOf(item.dramatic_stage);
    if (current < 0) {
      violations.push({ code: 'UNKNOWN_STAGE', memory_id: item.memory_id, stage: item.dramatic_stage });
      return;
    }
    if (current < previous) {
      violations.push({ code: 'DRAMATIC_REGRESSION', memory_id: item.memory_id, from: order[previous], to: item.dramatic_stage });
    }
    previous = Math.max(previous, current);
  });

  const duplicateMemoryIds = progression
    .map((item) => item.memory_id)
    .filter(Boolean)
    .filter((id, index, all) => all.indexOf(id) !== index);

  if (duplicateMemoryIds.length) violations.push({ code: 'DUPLICATE_MEMORY', memory_ids: [...new Set(duplicateMemoryIds)] });

  const blocking = violations.filter((item) => ['UNKNOWN_STAGE', 'DUPLICATE_MEMORY'].includes(item.code));
  return {
    coherent: blocking.length === 0,
    approved: blocking.length === 0 && progression.length >= 2,
    status: progression.length < 2 ? 'ARC_INSUFFICIENT_EVIDENCE' : blocking.length ? 'ARC_INVALID' : violations.length ? 'ARC_COHERENT_WITH_REGRESSIONS' : 'ARC_COHERENT',
    violations,
    blocking_violations: blocking,
    source_policy: 'Lacunas e regressões dramáticas são diagnósticas; apenas estrutura inválida ou evidência insuficiente bloqueiam o Truth Pipeline.',
  };
}
