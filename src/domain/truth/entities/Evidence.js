export class Evidence {
  constructor({
    evidenceId = null,
    memoryId,
    title = '',
    excerpt = '',
    sourceType = 'memory',
    confidence = 0,
    entities = [],
    dates = [],
    places = [],
    emotions = [],
    supports = [],
  }) {
    this.evidenceId = evidenceId;
    this.memoryId = memoryId;
    this.title = title || '';
    this.excerpt = String(excerpt || '').trim();
    this.sourceType = sourceType;
    this.confidence = Number(confidence) || 0;
    this.entities = Array.isArray(entities) ? entities : [];
    this.dates = Array.isArray(dates) ? dates : [];
    this.places = Array.isArray(places) ? places : [];
    this.emotions = Array.isArray(emotions) ? emotions : [];
    this.supports = Array.isArray(supports) ? supports : [];
  }

  isUsable() {
    return Boolean(this.memoryId && this.excerpt.length >= 20);
  }

  toDocumentBlock(index = 1) {
    return [
      `DOCUMENTO ${String(index).padStart(2, '0')}`,
      '',
      this.title ? `Título: ${this.title}` : null,
      '',
      this.excerpt,
      '',
      `Origem: Memória ${this.memoryId}`,
      `Confiança documental: ${Math.round(this.confidence * 100)}%`,
    ].filter(Boolean).join('\n');
  }

  toJSON() {
    return {
      evidence_id: this.evidenceId,
      memory_id: this.memoryId,
      title: this.title,
      excerpt: this.excerpt,
      source_type: this.sourceType,
      confidence: this.confidence,
      entities: this.entities,
      dates: this.dates,
      places: this.places,
      emotions: this.emotions,
      supports: this.supports,
    };
  }
}
