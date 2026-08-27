export class KnowledgeGraph {
  constructor({ authorId = null } = {}) {
    this.authorId = authorId;
    this.nodes = new Map();
    this.edges = new Map();
  }

  addNode(node) {
    if (!node?.key) return this;
    const existing = this.nodes.get(node.key);
    this.nodes.set(node.key, existing ? existing.merge(node) : node);
    return this;
  }

  addEdge(edge) {
    if (!edge?.key) return this;
    const existing = this.edges.get(edge.key);
    this.edges.set(edge.key, existing ? existing.merge(edge) : edge);
    return this;
  }

  summary() {
    const nodeTypes = {};
    for (const node of this.nodes.values()) {
      nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
    }
    return {
      author_id: this.authorId,
      node_count: this.nodes.size,
      edge_count: this.edges.size,
      node_types: nodeTypes,
    };
  }

  toJSON() {
    return {
      author_id: this.authorId,
      summary: this.summary(),
      nodes: [...this.nodes.values()].map((n) => n.toJSON()),
      edges: [...this.edges.values()].map((e) => e.toJSON()),
    };
  }
}
