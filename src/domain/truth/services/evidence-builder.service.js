import { Evidence } from '../entities/Evidence.js';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractSentences(content = '') {
  return clean(content)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

function pickEvidenceExcerpt(content = '', maxChars = 900) {
  const sentences = extractSentences(content);
  const excerpt = sentences.slice(0, 8).join(' ');
  return excerpt.length > maxChars ? `${excerpt.slice(0, maxChars).trim()}...` : excerpt;
}

export function buildEvidenceFromMemories(memories = []) {
  return (memories || [])
    .map((memory) => {
      const content = memory.content || memory.refined_content || memory.body || '';
      return new Evidence({
        evidenceId: memory.evidence_id || null,
        memoryId: memory.memory_id || memory.id,
        title: memory.title || '',
        excerpt: pickEvidenceExcerpt(content),
        confidence: Math.max(0.2, Math.min(1, (memory.truth_score || 50) / 100)),
        entities: memory.entities || [],
        dates: [memory.memory_date, memory.created_at, memory.narrative_date].filter(Boolean),
        places: memory.places || [],
        emotions: memory.emotions || [],
        supports: memory.supports || [],
      });
    })
    .filter((evidence) => evidence.isUsable());
}
