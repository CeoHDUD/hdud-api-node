import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildKnowledgeGraphUseCase, QueryKnowledgeGraphUseCase } from '../src/domain/knowledge-graph/index.js';

test('Knowledge Graph builds from memories', () => {
  const result = BuildKnowledgeGraphUseCase({
    authorId: 1,
    memories: [{ memory_id: 1, title: 'Primeiro dia de escola', content: 'Meu pai me levou para a escola em 1996. Senti medo e esperança.' }],
  });

  assert.equal(result.ok, true);
  assert.ok(result.graph.nodes.length >= 4);
  assert.ok(result.graph.edges.length >= 2);
});

test('Knowledge Graph query finds content', () => {
  const result = BuildKnowledgeGraphUseCase({
    authorId: 1,
    memories: [{ memory_id: 1, title: 'Escola', content: 'Minha mãe estava na escola.' }],
  });

  const found = QueryKnowledgeGraphUseCase({ graph: result.graph, query: { text: 'escola' } });
  assert.ok(found.nodes.length >= 1);
});
