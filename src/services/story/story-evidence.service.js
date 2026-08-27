// C:\HDUD_DATA\hdud-api-node\src\services\story\story-evidence.service.js
//
// GO LIVE 003.4 — Story Evidence Map
// Responsabilidade: construir mapa interno de evidência por parágrafo e por memória.

export const STORY_EVIDENCE_ENGINE_VERSION = "story-evidence-v1.0-go-live-003.4";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeMemory(memory, index = 0) {
  const memoryId = toPositiveInt(memory?.memory_id ?? memory?.id ?? memory?.memoryId);
  return {
    memory_id: memoryId,
    title: safeText(memory?.title || memory?.memory_title, memoryId ? `Memória ${memoryId}` : `Memória ${index + 1}`),
    content: safeText(memory?.content || memory?.description || memory?.summary, ""),
    memory_date: memory?.memory_date || memory?.narrative_date || memory?.event_date || memory?.created_at || null,
    truth_score: Number(memory?.truth_score ?? memory?.evidence?.truth_score ?? 0) || 0,
  };
}

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(value) {
  return [...new Set(normalizeToken(value).split(/\s+/).filter((token) => token.length >= 4))];
}

function paragraphize(content) {
  return safeText(content, "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function evidenceHits(paragraph, memory) {
  const paragraphTokens = tokensOf(paragraph);
  const memoryTokens = new Set(tokensOf(`${memory.title} ${memory.content}`));
  return paragraphTokens.filter((token) => memoryTokens.has(token));
}

export function buildEvidenceMap({ narrativeContent = "", memories = [], memoryScores = [] } = {}) {
  const normalizedMemories = safeArray(memories).map(normalizeMemory).filter((memory) => memory.memory_id);
  const scoreMap = new Map(safeArray(memoryScores).map((item) => [toPositiveInt(item?.memory_id), item]));
  const paragraphs = paragraphize(narrativeContent);

  const paragraphEvidence = paragraphs.map((paragraph, index) => {
    const matches = normalizedMemories
      .map((memory) => {
        const hits = evidenceHits(paragraph, memory);
        const score = scoreMap.get(memory.memory_id);
        return {
          memory_id: memory.memory_id,
          title: memory.title,
          truth_score: Number(score?.truth_score ?? memory.truth_score ?? 0) || 0,
          overlap: hits.length,
          evidence_tokens: hits.slice(0, 12),
        };
      })
      .filter((item) => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.truth_score - a.truth_score)
      .slice(0, 4);

    return {
      paragraph_index: index + 1,
      paragraph_preview: paragraph.length > 220 ? `${paragraph.slice(0, 217).trim()}...` : paragraph,
      memory_ids: matches.map((item) => item.memory_id),
      evidence: matches,
      evidence_count: matches.length,
      supported: matches.length > 0,
    };
  });

  const supported = paragraphEvidence.filter((item) => item.supported).length;
  const evidenceQuality = paragraphs.length ? Math.round((supported / paragraphs.length) * 100) : 0;

  return {
    engine: STORY_EVIDENCE_ENGINE_VERSION,
    paragraph_count: paragraphs.length,
    supported_paragraphs: supported,
    unsupported_paragraphs: Math.max(0, paragraphs.length - supported),
    evidence_quality: evidenceQuality,
    paragraphs: paragraphEvidence,
    memory_ids_used: [...new Set(paragraphEvidence.flatMap((item) => item.memory_ids))],
  };
}

export function buildEvidencePayload({ usedMemories = [], discardedMemories = [], truthReport = null, evidenceMap = null } = {}) {
  return {
    engine: STORY_EVIDENCE_ENGINE_VERSION,
    used_memories: safeArray(usedMemories).map(normalizeMemory).filter((memory) => memory.memory_id),
    discarded_memories: safeArray(discardedMemories).map(normalizeMemory).filter((memory) => memory.memory_id),
    truth_report: truthReport,
    evidence_map: evidenceMap,
  };
}

export const StoryEvidenceService = {
  buildEvidenceMap,
  buildEvidencePayload,
};
