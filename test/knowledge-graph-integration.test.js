import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBookChapterKnowledgeLineage } from '../src/services/book-truth/BookTruthKnowledgeGraphBridge.js';

test('Book Truth bridge maps evidence memories to graph nodes', () => {
  const lineage = buildBookChapterKnowledgeLineage({
    chapterId: 1,
    storyTruthReport: { evidence_map: { paragraphs: [{ evidence: [{ memory_id: 10 }] }] } },
    knowledgeGraph: { nodes: [{ key: 'MEMORY:memoria 10', type: 'MEMORY', label: 'Memória 10', memory_ids: [10] }], edges: [] },
  });

  assert.equal(lineage.lineage_quality, 'AUDITABLE');
  assert.equal(lineage.knowledge_nodes.length, 1);
});
