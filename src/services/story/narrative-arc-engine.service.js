import { buildNarrativeArcDraft } from './arc-builder.service.js';
import { validateNarrativeArc } from './arc-validation.service.js';
import { calculateArcCompletion } from './arc-completion.service.js';
import { scoreNarrativeArc } from './arc-scoring.service.js';

const ENGINE_VERSION = 'narrative-arc-engine-v6.4.3';

export function buildNarrativeArc({ candidate = {}, blueprint = null, memories = null } = {}) {
  const draft = buildNarrativeArcDraft({ candidate, blueprint, memories });
  const validation = validateNarrativeArc(draft);
  const completion = calculateArcCompletion(draft);
  const scoring = scoreNarrativeArc({ arc: draft, validation, completion, candidate });

  return {
    ...draft,
    engine: ENGINE_VERSION,
    status: validation.approved ? (completion.complete ? 'VALIDATED_COMPLETE_ARC' : 'VALIDATED_ARC_WITH_GAPS') : 'ARC_REJECTED',
    validation,
    completion,
    scoring,
    missing_stages: completion.missing_stages,
    can_proceed_to_truth: validation.approved,
    source_policy: 'Narrative Arc organiza dramaticamente memórias já autorizadas pelo Candidate/Blueprint; não cria fatos, memórias ou relações.',
  };
}

export function attachNarrativeArc(candidate = {}) {
  const narrativeArc = buildNarrativeArc({ candidate });
  return {
    ...candidate,
    narrative_arc: narrativeArc,
    validated_arc: narrativeArc.can_proceed_to_truth ? narrativeArc : null,
    arc_completion_score: narrativeArc.completion.completion_score,
    arc_consistency_score: narrativeArc.scoring.consistency_score,
    arc_score: narrativeArc.scoring.overall_arc_score,
  };
}

export const NarrativeArcEngine = { buildNarrativeArc, attachNarrativeArc };
