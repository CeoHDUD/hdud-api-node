// C:\HDUD_DATA\hdud-api-node\src\services\story\paragraph-evidence-builder.service.js

const DEFAULT_MIN_SCORE = 0.18;

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value = '') {
  const stopwords = new Set([
    'a','o','os','as','um','uma','uns','umas','de','do','da','dos','das','em','no','na','nos','nas','por','para','com','sem','que','e','ou','mas','se','me','te','ele','ela','eu','voce','voces','eles','elas','meu','minha','meus','minhas','seu','sua','seus','suas','foi','era','ser','estar','ter','haver','quando','onde','como','mais','menos','muito','muita','tambem','porque','pra','ao','aos','pela','pelo','pelas','pelos','isso','isto','aquele','aquela','ali','aqui'
  ]);
  return normalizeText(value).split(' ').filter((token) => token.length >= 3 && !stopwords.has(token));
}

function splitParagraphs(manuscript = '') {
  return String(manuscript || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function asMemory(memory = {}) {
  const id = memory.memory_id ?? memory.id ?? memory.source_id ?? null;
  return {
    memory_id: id,
    title: memory.title ?? memory.memory_title ?? '',
    content: memory.content ?? memory.memory_content ?? memory.refined_content ?? memory.transcription_text ?? '',
    phase: memory.phase_code ?? memory.phase_name ?? memory.phase ?? null,
    date: memory.memory_date ?? memory.created_at ?? memory.narrative_date ?? null,
    evidence_weight: Number(memory.evidence_weight ?? memory.weight ?? 0.5),
    origin: memory.origin_type ?? memory.source_type ?? 'memory',
  };
}

function jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = new Set([...a, ...b]).size || 1;
  return intersection / union;
}

function phraseSupport(paragraph, memoryContent) {
  const p = normalizeText(paragraph);
  const m = normalizeText(memoryContent);
  if (!p || !m) return 0;
  const paragraphTokens = tokenize(p);
  if (!paragraphTokens.length) return 0;
  const windows = [];
  for (let size of [8, 6, 4]) {
    for (let i = 0; i <= paragraphTokens.length - size; i++) {
      windows.push(paragraphTokens.slice(i, i + size).join(' '));
    }
  }
  const hits = windows.filter((window) => window && m.includes(window)).length;
  return Math.min(1, hits / Math.max(1, Math.ceil(windows.length * 0.22)));
}

function scoreMemoryForParagraph(paragraph, memory) {
  const paragraphTokens = tokenize(paragraph);
  const memoryTokens = tokenize(`${memory.title} ${memory.content}`);
  const lexical = jaccard(paragraphTokens, memoryTokens);
  const phrase = phraseSupport(paragraph, `${memory.title} ${memory.content}`);
  const weight = Math.max(0.05, Math.min(1, Number(memory.evidence_weight || 0.5)));
  const coverage = Math.min(1, lexical * 3.2);
  const score = Math.min(1, (coverage * 0.48) + (phrase * 0.37) + (weight * 0.15));
  return Number(score.toFixed(4));
}

function classifyQuality(score, sourceCount) {
  if (score >= 0.82 && sourceCount >= 2) return 'strong';
  if (score >= 0.68) return 'good';
  if (score >= 0.46) return 'moderate';
  if (score >= 0.25) return 'weak';
  return 'unsupported';
}

function classifyRisk(score, quality) {
  if (quality === 'unsupported') return 'critical';
  if (score < 0.38) return 'high';
  if (score < 0.62) return 'medium';
  return 'low';
}

function buildLineage({ paragraphOrder, sourceMemories, evidenceQuality, truthScore, generationContext = {} }) {
  return {
    lineage_type: 'story_paragraph_evidence',
    generation_stage: generationContext.stage || 'story_generation',
    truth_prompt_version: generationContext.truth_prompt_version || generationContext.prompt_version || null,
    truth_memory_selection_id: generationContext.truth_memory_selection_id || null,
    story_id: generationContext.story_id || null,
    paragraph_order: paragraphOrder,
    source_memory_ids: sourceMemories.map((m) => m.memory_id),
    evidence_quality: evidenceQuality,
    truth_score: truthScore,
    generated_at: new Date().toISOString(),
  };
}

export function buildParagraphEvidenceMap({ manuscript, memories = [], generationContext = {}, minScore = DEFAULT_MIN_SCORE } = {}) {
  const paragraphs = splitParagraphs(manuscript);
  const normalizedMemories = memories.map(asMemory).filter((memory) => memory.memory_id && String(memory.content || memory.title || '').trim());

  const map = paragraphs.map((paragraph, index) => {
    const scored = normalizedMemories
      .map((memory) => ({ ...memory, support_score: scoreMemoryForParagraph(paragraph, memory) }))
      .filter((memory) => memory.support_score >= minScore)
      .sort((a, b) => b.support_score - a.support_score)
      .slice(0, 5);

    const topScores = scored.map((item) => item.support_score);
    const truthScore = topScores.length
      ? Number(Math.min(1, topScores.reduce((sum, score) => sum + score, 0) / Math.max(1, Math.min(3, topScores.length)) * (topScores.length >= 2 ? 1.08 : 0.96)).toFixed(4))
      : 0;

    const evidenceQuality = classifyQuality(truthScore, scored.length);
    const hallucinationRisk = classifyRisk(truthScore, evidenceQuality);

    return {
      paragraph_id: `p_${String(index + 1).padStart(3, '0')}`,
      paragraph_order: index + 1,
      paragraph,
      source_memories: scored.map((memory) => ({
        memory_id: memory.memory_id,
        title: memory.title,
        phase: memory.phase,
        date: memory.date,
        evidence_weight: memory.evidence_weight,
        support_score: memory.support_score,
        origin: memory.origin,
      })),
      evidence_quality: evidenceQuality,
      truth_score: truthScore,
      hallucination_risk: hallucinationRisk,
      lineage: buildLineage({ paragraphOrder: index + 1, sourceMemories: scored, evidenceQuality, truthScore, generationContext }),
    };
  });

  return map;
}

export function assertEveryParagraphHasEvidence(evidenceMap = []) {
  const unsupported = evidenceMap.filter((item) => !Array.isArray(item.source_memories) || item.source_memories.length === 0 || item.evidence_quality === 'unsupported');
  return {
    ok: unsupported.length === 0,
    unsupported_count: unsupported.length,
    unsupported_paragraphs: unsupported.map((item) => ({ paragraph_id: item.paragraph_id, paragraph_order: item.paragraph_order })),
  };
}

export default {
  buildParagraphEvidenceMap,
  assertEveryParagraphHasEvidence,
};
