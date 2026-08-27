import { TRUTH_DECISION } from '../contracts/truth-contract-version.js';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function scoreMemory(memory = {}, candidate = {}) {
  const content = normalizeText(memory.content || memory.refined_content || memory.body);
  const title = normalizeText(memory.title);
  const candidateText = normalizeText([
    candidate.title,
    candidate.summary,
    candidate.description,
    candidate.theme,
    ...(candidate.keywords || []),
  ].join(' ')).toLowerCase();

  const words = new Set(candidateText.split(/\W+/).filter((w) => w.length >= 4));
  const memoryText = `${title} ${content}`.toLowerCase();

  let keywordHits = 0;
  for (const word of words) {
    if (memoryText.includes(word)) keywordHits += 1;
  }

  const lengthScore = Math.min(30, Math.floor(content.length / 120));
  const relevanceScore = Math.min(35, keywordHits * 5);
  const documentaryScore = content.length >= 80 ? 25 : 10;
  const dateScore = memory.memory_date || memory.created_at || memory.narrative_date ? 10 : 4;

  return Math.max(0, Math.min(100, lengthScore + relevanceScore + documentaryScore + dateScore));
}

export function selectTruthMemories(candidate = {}, memories = [], options = {}) {
  const minKeepScore = options.minKeepScore ?? 45;
  const minOptionalScore = options.minOptionalScore ?? 25;

  const selected = [];
  const discarded = [];
  const optional = [];

  for (const memory of memories || []) {
    const truthScore = scoreMemory(memory, candidate);
    const decorated = {
      ...memory,
      truth_score: truthScore,
      relevance_score: truthScore,
      uniqueness_score: Math.min(100, Math.max(20, Math.floor((normalizeText(memory.content).length || 1) / 20))),
      contradiction_score: 0,
      editorial_value: truthScore >= 65 ? 'HIGH' : truthScore >= 45 ? 'MEDIUM' : 'LOW',
    };

    if (truthScore >= minKeepScore) {
      selected.push({ ...decorated, truth_decision: TRUTH_DECISION.KEEP });
    } else if (truthScore >= minOptionalScore) {
      optional.push({ ...decorated, truth_decision: TRUTH_DECISION.OPTIONAL });
    } else {
      discarded.push({ ...decorated, truth_decision: TRUTH_DECISION.DROP });
    }
  }

  selected.sort((a, b) => b.truth_score - a.truth_score);
  optional.sort((a, b) => b.truth_score - a.truth_score);
  discarded.sort((a, b) => b.truth_score - a.truth_score);

  return {
    selectedMemories: selected,
    optionalMemories: optional,
    discardedMemories: discarded,
    selectionSummary: {
      total: memories.length,
      keep: selected.length,
      optional: optional.length,
      drop: discarded.length,
    },
  };
}
