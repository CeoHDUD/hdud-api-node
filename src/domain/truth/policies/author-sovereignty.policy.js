export class AuthorSovereigntyPolicy {
  static validateTruthReport(report = {}) {
    const failures = [];

    if ((report.truth_score ?? report.truthScore ?? 0) < 70) {
      failures.push('Truth Score abaixo do mínimo editorial.');
    }

    if ((report.hallucination_risk ?? report.hallucinationRisk) === 'HIGH') {
      failures.push('Risco de alucinação alto.');
    }

    const paragraphs = report.evidence_map?.paragraphs || report.evidenceMap?.paragraphs || [];
    const unsupported = paragraphs.filter((p) => !p.evidence?.length);

    if (unsupported.length > 0) {
      failures.push(`${unsupported.length} parágrafo(s) sem evidência documental.`);
    }

    return {
      approved: failures.length === 0,
      failures,
    };
  }

  static rules() {
    return [
      'Toda afirmação deve ser suportada por pelo menos uma memória.',
      'Nenhum personagem pode ser criado sem origem documental.',
      'Nenhuma emoção pode ser atribuída sem evidência explícita.',
      'Nenhuma relação de causa e efeito pode ser inferida sem suporte.',
      'Toda versão deve preservar sua linhagem de evidências.',
      'O autor deve conseguir auditar a origem de qualquer trecho.',
    ];
  }
}
