import { stageOrder } from './arc-progression.service.js';

export function calculateArcCompletion(arc = {}) {
  const present = new Set((arc.stages || []).map((stage) => stage.stage));
  const expected = stageOrder();
  const missing = expected.filter((stage) => !present.has(stage));
  const critical = ['BEGINNING', 'TRANSFORMATION'].filter((stage) => !present.has(stage));
  const score = Math.round((present.size / expected.length) * 100);
  return {
    completion_score: score,
    completion_ratio: Number((present.size / expected.length).toFixed(4)),
    present_stages: expected.filter((stage) => present.has(stage)),
    missing_stages: missing,
    critical_missing_stages: critical,
    complete: missing.length === 0,
    complete_enough: present.size >= 3 && critical.length === 0,
    source_policy: 'Lacunas reduzem completude, mas não invalidam automaticamente um arco narrativo coerente.',
  };
}
