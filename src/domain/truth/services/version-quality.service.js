export function calculateVersionQuality({ truthScore = 0, narrativeQuality = 80, validation = {} } = {}) {
  const invalidParagraphs = (validation.paragraphs || []).filter((p) => p.validation_status === 'INVALID').length;
  const warningParagraphs = (validation.paragraphs || []).filter((p) => p.validation_status === 'WARNING').length;

  const quality = Math.max(0, Math.min(100, Math.round(
    truthScore * 0.6 + narrativeQuality * 0.3 - invalidParagraphs * 8 - warningParagraphs * 3
  )));

  return {
    narrative_quality: narrativeQuality,
    version_quality: quality,
    publication_recommendation: quality >= 75 ? 'READY' : quality >= 55 ? 'REVIEW_REQUIRED' : 'BLOCKED',
  };
}
