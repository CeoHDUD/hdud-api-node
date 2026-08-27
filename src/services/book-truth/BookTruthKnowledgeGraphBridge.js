export function buildBookChapterKnowledgeLineage({ chapterId, storyTruthReport, knowledgeGraph } = {}) {
  const memoryIds = new Set();

  for (const paragraph of storyTruthReport?.evidence_map?.paragraphs || []) {
    for (const evidence of paragraph.evidence || []) {
      if (evidence.memory_id) memoryIds.add(Number(evidence.memory_id));
    }
  }

  const nodes = (knowledgeGraph?.nodes || []).filter((node) =>
    (node.memory_ids || []).some((id) => memoryIds.has(Number(id)))
  );

  const keys = new Set(nodes.map((node) => node.key));
  const edges = (knowledgeGraph?.edges || []).filter((edge) =>
    keys.has(edge.source_key) || keys.has(edge.target_key)
  );

  return {
    chapter_id: chapterId,
    memory_ids: [...memoryIds],
    knowledge_nodes: nodes,
    knowledge_edges: edges,
    lineage_quality: nodes.length ? 'AUDITABLE' : 'WEAK',
  };
}
