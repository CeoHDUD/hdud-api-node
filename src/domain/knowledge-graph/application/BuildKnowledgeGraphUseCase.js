import { buildKnowledgeGraph } from '../services/KnowledgeGraphBuilder.js';
import { serializeKnowledgeGraph } from '../services/KnowledgeGraphSerializer.js';
import { validateKnowledgeGraph } from '../services/KnowledgeGraphValidator.js';

export function BuildKnowledgeGraphUseCase({ authorId, memories = [] } = {}) {
  const graph = serializeKnowledgeGraph(buildKnowledgeGraph({ authorId, memories }));
  const validation = validateKnowledgeGraph(graph);
  return { ok: validation.valid, graph, validation };
}
