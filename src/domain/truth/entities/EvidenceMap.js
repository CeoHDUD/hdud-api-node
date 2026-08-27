export class EvidenceMap {
  constructor({ storyId = null, paragraphs = [] } = {}) {
    this.storyId = storyId;
    this.paragraphs = Array.isArray(paragraphs) ? paragraphs : [];
  }

  addParagraph(paragraph) {
    this.paragraphs.push({
      paragraph_index: paragraph.paragraph_index ?? this.paragraphs.length + 1,
      paragraph_text: paragraph.paragraph_text || '',
      evidence: paragraph.evidence || [],
      truth_score: paragraph.truth_score ?? 0,
      evidence_quality: paragraph.evidence_quality || 'NONE',
      hallucination_risk: paragraph.hallucination_risk || 'MEDIUM',
      validation_status: paragraph.validation_status || 'WARNING',
      warnings: paragraph.warnings || [],
    });
  }

  summary() {
    if (!this.paragraphs.length) {
      return {
        paragraph_count: 0,
        average_truth_score: 0,
        unsupported_paragraphs: 0,
      };
    }

    const average = Math.round(
      this.paragraphs.reduce((sum, item) => sum + Number(item.truth_score || 0), 0) / this.paragraphs.length
    );

    return {
      paragraph_count: this.paragraphs.length,
      average_truth_score: average,
      unsupported_paragraphs: this.paragraphs.filter((p) => !p.evidence?.length).length,
    };
  }

  toJSON() {
    return {
      story_id: this.storyId,
      summary: this.summary(),
      paragraphs: this.paragraphs,
    };
  }
}
