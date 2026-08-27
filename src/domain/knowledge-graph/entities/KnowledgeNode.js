function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export class KnowledgeNode {
  constructor({ nodeId = null, type, label, memoryIds = [], evidence = [], confidence = 0.5, metadata = {} }) {
    if (!type || !label) throw new Error('KnowledgeNode requires type and label');
    this.nodeId = nodeId;
    this.type = String(type).toUpperCase();
    this.label = String(label).trim();
    this.key = `${this.type}:${normalize(this.label)}`;
    this.memoryIds = [...new Set((memoryIds || []).map(Number).filter(Boolean))];
    this.evidence = Array.isArray(evidence) ? evidence : [];
    this.confidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    this.metadata = metadata || {};
  }

  merge(other) {
    if (!other || other.key !== this.key) return this;
    this.memoryIds = [...new Set([...this.memoryIds, ...(other.memoryIds || [])])];
    this.evidence = [...this.evidence, ...(other.evidence || [])];
    this.confidence = Math.max(this.confidence, Number(other.confidence || 0));
    this.metadata = { ...other.metadata, ...this.metadata };
    return this;
  }

  toJSON() {
    return {
      node_id: this.nodeId,
      type: this.type,
      label: this.label,
      key: this.key,
      memory_ids: this.memoryIds,
      evidence: this.evidence,
      confidence: this.confidence,
      metadata: this.metadata,
    };
  }
}
