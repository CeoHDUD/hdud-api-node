import { StoryLineage } from '../entities/StoryLineage.js';

export function buildStoryLineage({ storyId, versionId, previousVersionId, previousEvidenceMap = null, nextEvidenceMap = null } = {}) {
  const previousIds = new Set(
    (previousEvidenceMap?.paragraphs || []).flatMap((p) => (p.evidence || []).map((e) => String(e.memory_id)))
  );
  const nextIds = new Set(
    (nextEvidenceMap?.paragraphs || []).flatMap((p) => (p.evidence || []).map((e) => String(e.memory_id)))
  );

  const added = [...nextIds].filter((id) => !previousIds.has(id));
  const removed = [...previousIds].filter((id) => !nextIds.has(id));

  return new StoryLineage({
    storyId,
    versionId,
    previousVersionId,
    changes: [
      ...(added.length ? [`Memórias adicionadas à linhagem: ${added.join(', ')}`] : []),
      ...(removed.length ? [`Memórias removidas da linhagem: ${removed.join(', ')}`] : []),
    ],
    evidenceDelta: { added_memory_ids: added, removed_memory_ids: removed },
  }).toJSON();
}
