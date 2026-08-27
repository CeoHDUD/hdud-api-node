import { queryKnowledgeGraph } from '../services/KnowledgeGraphQuery.js';

export function QueryKnowledgeGraphUseCase({ graph, query }) {
  return queryKnowledgeGraph(graph, query);
}
