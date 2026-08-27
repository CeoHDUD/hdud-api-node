export class KnowledgeEdge {
  constructor({ edgeId = null, sourceKey, targetKey, type, memoryIds = [], evidence = [], confidence = 0.5, metadata = {} }) {
    if (!sourceKey || !targetKey || !type) throw new Error('KnowledgeEdge requires sourceKey, targetKey and type');
    this.edgeId = edgeId;
    this.sourceKey = sourceKey;
    this.targetKey = targetKey;
    this.type = String(type).toUpperCase();
    this.key = `${sourceKey}|${this.type}|${targetKey}`;
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
      edge_id: this.edgeId,
      source_key: this.sourceKey,
      target_key: this.targetKey,
      type: this.type,
      key: this.key,
      memory_ids: this.memoryIds,
      evidence: this.evidence,
      confidence: this.confidence,
      metadata: this.metadata,
    };
  }
}
