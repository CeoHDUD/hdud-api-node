export function buildNarrativePayload(evidenceList = [], candidate = {}) {
  const header = [
    'MANUSCRITO DOCUMENTAL HDUD',
    '',
    'Instrução de leitura:',
    'Os documentos abaixo são as únicas fontes autorizadas para a geração da história.',
    'Não use metadados invisíveis, IDs técnicos ou inferências externas.',
    '',
    candidate.title ? `Título editorial sugerido: ${candidate.title}` : null,
    candidate.summary ? `Resumo do candidato: ${candidate.summary}` : null,
    '',
    'FONTES DOCUMENTAIS',
    '',
  ].filter(Boolean).join('\n');

  const documents = evidenceList.map((evidence, index) => evidence.toDocumentBlock(index + 1)).join('\n\n---\n\n');

  return `${header}${documents}`;
}
