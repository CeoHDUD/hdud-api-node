import { EvidenceMap } from '../entities/EvidenceMap.js';

export function buildEvidenceMap({ storyId = null, validation = {} } = {}) {
  const map = new EvidenceMap({ storyId });

  for (const paragraph of validation.paragraphs || []) {
    map.addParagraph(paragraph);
  }

  return map.toJSON();
}
