import { buildNarrativeArc } from './src/services/story/narrative-arc-engine.service.js';
const roles = ['BIRTH','RELATIONSHIP','LOVE','INCITING_EVENT','TRANSFORMATION','MARRIAGE','CLIMAX','PATERNITY','CHILD_BIRTH','CONTINUITY'];
const candidate = {
  candidate_id: 'candidate_bruna_family',
  title: 'Como conheci Bruna e construímos nossa família',
  graph_narrative_score: 96,
  truth_score: 94,
  story_blueprint: { status: 'READY_FOR_AUTHOR_REVIEW' },
  memories: roles.map((narrative_role_code, index) => ({ memory_id: index + 1, title: narrative_role_code, narrative_role_code })),
};
const arc = buildNarrativeArc({ candidate });
console.log(JSON.stringify(arc, null, 2));
if (!arc.can_proceed_to_truth) process.exit(1);
if (arc.progression.length !== 10) process.exit(2);
if (arc.completion.completion_score < 80) process.exit(3);
