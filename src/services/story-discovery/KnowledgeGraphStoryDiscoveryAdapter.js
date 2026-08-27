import { AuthorKnowledgeGraphService } from '../knowledge-graph/AuthorKnowledgeGraphService.js';

export async function discoverStorySignalsFromKnowledgeGraph({ authorId, query = '' } = {}) {
  const service = new AuthorKnowledgeGraphService();
  const result = await service.query(authorId, { text: query });

  if (!result.ok) return { ok: false, signals: [], error: result.error };

  const grouped = new Map();
  for (const node of result.nodes || []) {
    for (const memoryId of node.memory_ids || []) {
      if (!grouped.has(memoryId)) grouped.set(memoryId, []);
      grouped.get(memoryId).push(node);
    }
  }

  return {
    ok: true,
    signals: [...grouped.entries()].map(([memoryId, nodes]) => ({
      memory_id: Number(memoryId),
      nodes,
      node_count: nodes.length,
      story_signal_score: Math.min(100, nodes.length * 12),
    })),
    graph_summary: result.summary,
  };
}
