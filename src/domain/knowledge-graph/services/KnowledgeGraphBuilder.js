import { KnowledgeGraph } from '../entities/KnowledgeGraph.js';
import { KnowledgeNode } from '../entities/KnowledgeNode.js';
import { KnowledgeEdge } from '../entities/KnowledgeEdge.js';
import { KNOWLEDGE_NODE_TYPE, KNOWLEDGE_EDGE_TYPE } from '../contracts/knowledge-graph-contract-version.js';

const PERSON_HINTS = ['pai','mãe','mae','filho','filha','esposa','marido','irmão','irmao','irmã','irma','avô','avó','professor','amigo','amiga'];
const PLACE_HINTS = ['casa','escola','cidade','hospital','rua','bairro','empresa','trabalho','igreja','praia','campo'];
const EMOTION_HINTS = ['medo','alegria','tristeza','orgulho','saudade','raiva','esperança','dor','amor'];

function normalizeText(value = '') {
  return String(value || '').toLowerCase();
}

function containsWord(text, word) {
  return new RegExp(`(^|\\W)${word}($|\\W)`, 'i').test(text);
}

function evidence(memory) {
  return {
    memory_id: Number(memory.memory_id || memory.id),
    title: memory.title || null,
    excerpt: String(memory.content || '').replace(/\s+/g, ' ').trim().slice(0, 420),
  };
}

function makeNode(type, label, memory, confidence = 0.6) {
  const memoryId = Number(memory.memory_id || memory.id);
  return new KnowledgeNode({
    type,
    label,
    memoryIds: [memoryId],
    confidence,
    evidence: [evidence(memory)],
  });
}

export function buildKnowledgeGraph({ authorId, memories = [] } = {}) {
  const graph = new KnowledgeGraph({ authorId });

  const author = new KnowledgeNode({
    type: KNOWLEDGE_NODE_TYPE.AUTHOR,
    label: `Autor ${authorId}`,
    confidence: 1,
    metadata: { author_id: authorId },
  });
  graph.addNode(author);

  for (const memory of memories || []) {
    const memoryId = Number(memory.memory_id || memory.id);
    if (!memoryId) continue;

    const content = normalizeText(`${memory.title || ''} ${memory.content || ''}`);
    const ev = evidence(memory);

    const memoryNode = makeNode(KNOWLEDGE_NODE_TYPE.MEMORY, `Memória ${memoryId}`, memory, 1);
    const eventNode = makeNode(KNOWLEDGE_NODE_TYPE.EVENT, memory.title || `Evento da memória ${memoryId}`, memory, 0.75);
    graph.addNode(memoryNode).addNode(eventNode);

    graph.addEdge(new KnowledgeEdge({
      sourceKey: author.key,
      targetKey: memoryNode.key,
      type: KNOWLEDGE_EDGE_TYPE.SUPPORTED_BY,
      memoryIds: [memoryId],
      evidence: [ev],
      confidence: 1,
    }));

    graph.addEdge(new KnowledgeEdge({
      sourceKey: memoryNode.key,
      targetKey: eventNode.key,
      type: KNOWLEDGE_EDGE_TYPE.MENTIONS,
      memoryIds: [memoryId],
      evidence: [ev],
      confidence: 0.9,
    }));

    for (const label of PERSON_HINTS.filter((x) => containsWord(content, x))) {
      const node = makeNode(KNOWLEDGE_NODE_TYPE.PERSON, label, memory, 0.65);
      graph.addNode(node);
      graph.addEdge(new KnowledgeEdge({ sourceKey: memoryNode.key, targetKey: node.key, type: KNOWLEDGE_EDGE_TYPE.MENTIONS, memoryIds: [memoryId], evidence: [ev], confidence: 0.65 }));
    }

    for (const label of PLACE_HINTS.filter((x) => containsWord(content, x))) {
      const node = makeNode(KNOWLEDGE_NODE_TYPE.PLACE, label, memory, 0.6);
      graph.addNode(node);
      graph.addEdge(new KnowledgeEdge({ sourceKey: memoryNode.key, targetKey: node.key, type: KNOWLEDGE_EDGE_TYPE.MENTIONS, memoryIds: [memoryId], evidence: [ev], confidence: 0.6 }));
    }

    for (const label of EMOTION_HINTS.filter((x) => containsWord(content, x))) {
      const node = makeNode(KNOWLEDGE_NODE_TYPE.EMOTION, label, memory, 0.55);
      graph.addNode(node);
      graph.addEdge(new KnowledgeEdge({ sourceKey: memoryNode.key, targetKey: node.key, type: KNOWLEDGE_EDGE_TYPE.MENTIONS, memoryIds: [memoryId], evidence: [ev], confidence: 0.55 }));
    }

    const years = [...content.matchAll(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2})\b/g)].map((m) => m[1]);
    for (const year of years) {
      const node = makeNode(KNOWLEDGE_NODE_TYPE.PERIOD, year, memory, 0.8);
      graph.addNode(node);
      graph.addEdge(new KnowledgeEdge({ sourceKey: memoryNode.key, targetKey: node.key, type: KNOWLEDGE_EDGE_TYPE.MENTIONS, memoryIds: [memoryId], evidence: [ev], confidence: 0.8 }));
    }
  }

  return graph;
}
