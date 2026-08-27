import { TruthScore } from '../value-objects/TruthScore.js';
import { EvidenceQuality } from '../value-objects/EvidenceQuality.js';
import { HallucinationRisk } from '../value-objects/HallucinationRisk.js';

function normalize(value = '') {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function paragraphSupportScore(paragraph = {}, evidenceList = []) {
  const ids = new Set((paragraph.evidence_memory_ids || paragraph.memory_ids || []).map(String));
  const supporting = evidenceList.filter((e) => ids.has(String(e.memoryId)));

  if (!supporting.length) return { score: 0, evidence: [], warnings: ['Parágrafo sem memória de origem declarada.'] };

  const paragraphText = normalize(paragraph.text || paragraph.paragraph_text || '');
  let overlap = 0;

  for (const evidence of supporting) {
    const excerptWords = new Set(normalize(evidence.excerpt).split(/\W+/).filter((w) => w.length >= 5));
    for (const word of excerptWords) {
      if (paragraphText.includes(word)) overlap += 1;
    }
  }

  const lexicalScore = Math.min(100, overlap * 6);
  const declaredScore = supporting.length ? 55 : 0;
  const score = Math.max(declaredScore, lexicalScore);

  const warnings = [];
  if (score < 45) warnings.push('Baixa sobreposição documental entre parágrafo e evidência.');
  if ((paragraph.text || '').match(/certamente|sem dúvida|sempre|nunca|por isso|por causa|com a intenção/i)) {
    warnings.push('Parágrafo contém linguagem de causalidade ou intenção que exige revisão.');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    evidence: supporting.map((item) => item.toJSON()),
    warnings,
  };
}

export function validateTruthResponse(aiResponse = {}, evidenceList = []) {
  const manuscript = Array.isArray(aiResponse.manuscript) ? aiResponse.manuscript : [];
  const paragraphs = [];
  let unsupportedClaims = 0;
  let weakEvidence = 0;

  manuscript.forEach((paragraph, index) => {
    const support = paragraphSupportScore(paragraph, evidenceList);

    if (!support.evidence.length) unsupportedClaims += 1;
    if (support.score < 60) weakEvidence += 1;

    const quality = EvidenceQuality.fromScore(support.score).toJSON();
    const risk = HallucinationRisk.fromTruthScore(support.score).toJSON();

    paragraphs.push({
      paragraph_index: paragraph.paragraph_index || index + 1,
      paragraph_text: paragraph.text || paragraph.paragraph_text || '',
      evidence: support.evidence,
      truth_score: support.score,
      evidence_quality: quality,
      hallucination_risk: risk,
      validation_status: support.score >= 70 ? 'VALID' : support.score >= 45 ? 'WARNING' : 'INVALID',
      warnings: support.warnings,
      truth_notes: paragraph.truth_notes || [],
    });
  });

  const score = TruthScore.fromSignals({ unsupportedClaims, weakEvidence }).value;
  return {
    truth_score: score,
    evidence_quality: EvidenceQuality.fromScore(score).toJSON(),
    hallucination_risk: HallucinationRisk.fromTruthScore(score).toJSON(),
    status: score >= 70 ? 'VALID' : score >= 45 ? 'WARNING' : 'INVALID',
    paragraphs,
    warnings: [
      ...(aiResponse.warnings || []),
      ...(unsupportedClaims ? [`${unsupportedClaims} parágrafo(s) sem evidência declarada.`] : []),
      ...(weakEvidence ? [`${weakEvidence} parágrafo(s) com evidência fraca.`] : []),
    ],
  };
}
