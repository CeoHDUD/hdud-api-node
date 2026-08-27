export function queryKnowledgeGraph(graph = {}, query = {}) {
  const text = String(query.text || query.q || '').trim().toLowerCase();
  const type = query.type ? String(query.type).toUpperCase() : null;

  const nodes = (graph.nodes || []).filter((node) => {
    if (type && node.type !== type) return false;
    if (!text) return true;
    return `${node.type} ${node.label} ${node.key} ${(node.evidence || []).map((e) => e.excerpt).join(' ')}`.toLowerCase().includes(text);
  });

  const keys = new Set(nodes.map((n) => n.key));
  const edges = (graph.edges || []).filter((edge) => keys.has(edge.source_key) || keys.has(edge.target_key));

  return { query, nodes, edges, summary: { node_count: nodes.length, edge_count: edges.length } };
}
