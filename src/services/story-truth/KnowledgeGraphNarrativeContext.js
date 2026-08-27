import { buildGraphForLLM } from '../../domain/knowledge-graph/index.js';
import { AuthorKnowledgeGraphService } from '../knowledge-graph/AuthorKnowledgeGraphService.js';

export async function loadKnowledgeGraphNarrativeContext({ authorId, maxNodes = 80, maxEdges = 120 } = {}) {
  const service = new AuthorKnowledgeGraphService();
  let latest = await service.latest(authorId);

  if (!latest) {
    const built = await service.buildForAuthor(authorId);
    latest = { graph: built.graph, validation: built.validation };
  }

  return {
    graph: latest.graph,
    validation: latest.validation,
    llm_context: buildGraphForLLM(latest.graph, { maxNodes, maxEdges }),
  };
}
