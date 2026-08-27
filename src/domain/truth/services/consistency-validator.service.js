function normalize(value = '') {
  return String(value || '').toLowerCase().trim();
}

export function validateConsistency({ currentResponse = {}, previousVersions = [] } = {}) {
  const warnings = [];
  const text = normalize((currentResponse.manuscript || []).map((p) => p.text).join(' '));

  for (const version of previousVersions || []) {
    const previousText = normalize(version.content || version.manuscript || '');

    if (!previousText) continue;

    const tensionPairs = [
      ['sempre', 'nunca'],
      ['recife', 'são paulo'],
      ['rio de janeiro', 'são paulo'],
      ['feliz', 'triste'],
      ['orgulho', 'vergonha'],
    ];

    for (const [a, b] of tensionPairs) {
      if ((text.includes(a) && previousText.includes(b)) || (text.includes(b) && previousText.includes(a))) {
        warnings.push({
          type: 'POSSIBLE_NARRATIVE_TENSION',
          message: `Possível tensão narrativa entre "${a}" e "${b}". Revisão autoral recomendada.`,
        });
      }
    }
  }

  return {
    status: warnings.length ? 'WARNING' : 'VALID',
    warnings,
  };
}
