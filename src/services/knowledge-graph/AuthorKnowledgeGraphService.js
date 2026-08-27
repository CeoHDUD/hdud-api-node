import { getPool } from '../../db.js';
import { BuildKnowledgeGraphUseCase, QueryKnowledgeGraphUseCase } from '../../domain/knowledge-graph/index.js';
import { KnowledgeGraphPersistence } from './KnowledgeGraphPersistence.js';

export class AuthorKnowledgeGraphService {
  constructor({ pool = null } = {}) {
    this.pool = pool;
  }

  async buildForAuthor(authorId) {
    const pool = this.pool || await getPool();
    const persistence = new KnowledgeGraphPersistence(pool);
    const memories = await persistence.loadAuthorMemories(authorId);
    const result = BuildKnowledgeGraphUseCase({ authorId, memories });
    const saved = await persistence.saveGraph({ authorId, graph: result.graph, validation: result.validation });
    return { ok: result.ok, ...saved, graph: result.graph, validation: result.validation, memory_count: memories.length };
  }

  async latest(authorId) {
    const pool = this.pool || await getPool();
    return new KnowledgeGraphPersistence(pool).loadLatestGraph(authorId);
  }

  async query(authorId, query) {
    const latest = await this.latest(authorId);
    if (!latest) return { ok: false, error: 'KNOWLEDGE_GRAPH_NOT_FOUND' };
    return { ok: true, ...QueryKnowledgeGraphUseCase({ graph: latest.graph, query }) };
  }
}
