export function validateKnowledgeGraph(graph = {}) {
  const failures = [];
  const keys = new Set((graph.nodes || []).map((n) => n.key));

  for (const node of graph.nodes || []) {
    if (!node.key || !node.type || !node.label) failures.push({ type: 'INVALID_NODE', node });
  }

  for (const edge of graph.edges || []) {
    if (!keys.has(edge.source_key) || !keys.has(edge.target_key)) failures.push({ type: 'BROKEN_EDGE', edge });
    if (edge.type === 'CAUSES' && Number(edge.confidence || 0) < 0.85) failures.push({ type: 'UNSUPPORTED_CAUSALITY', edge });
  }

  return { valid: failures.length === 0, failures };
}
