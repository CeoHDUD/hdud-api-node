export function serializeKnowledgeGraph(graph) {
  return typeof graph?.toJSON === 'function' ? graph.toJSON() : graph;
}

export function buildGraphForLLM(graph = {}, options = {}) {
  const maxNodes = Number(options.maxNodes || 80);
  const maxEdges = Number(options.maxEdges || 120);

  return [
    'AUTHOR KNOWLEDGE GRAPH HDUD',
    '',
    'NÓS',
    ...(graph.nodes || []).slice(0, maxNodes).map((n) => `- [${n.type}] ${n.label} (${n.key})`),
    '',
    'RELAÇÕES',
    ...(graph.edges || []).slice(0, maxEdges).map((e) => `- ${e.source_key} --${e.type}--> ${e.target_key}`),
  ].join('\n');
}
