import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryTruthUseCase, validateStoryUseCase, AuthorSovereigntyPolicy } from '../src/domain/truth/index.js';

test('Truth Domain builds fallback documentary story when AI is not configured', async () => {
  const report = await buildStoryTruthUseCase({
    candidate: { id: 1, title: 'Primeira história', summary: 'infância escola família' },
    memories: [
      { memory_id: 10, title: 'Infância', content: 'Eu estudava perto de casa e lembro da minha família me esperando no portão da escola.' },
      { memory_id: 11, title: 'Outro tema', content: 'Uma memória sobre trabalho, anos depois, em outra fase da vida.' },
    ],
  });

  assert.equal(report.candidate_id, 1);
  assert.ok(report.truth_score >= 0);
  assert.ok(report.evidence_map.paragraphs.length >= 1);
});

test('Truth Validator marks unsupported paragraph as invalid or warning', () => {
  const validation = validateStoryUseCase({
    storyId: 1,
    aiResponse: {
      manuscript: [
        { paragraph_index: 1, text: 'O pai dele ficou orgulhoso e chorou de emoção.', evidence_memory_ids: [] },
      ],
    },
    memories: [
      { memory_id: 10, title: 'Memória', content: 'O texto fala apenas de uma ida para a escola.' },
    ],
  });

  assert.ok(validation.validation.truth_score < 100);
  assert.equal(validation.evidence_map.paragraphs[0].evidence.length, 0);
});

test('Author Sovereignty blocks high-risk truth reports', () => {
  const result = AuthorSovereigntyPolicy.validateTruthReport({
    truth_score: 40,
    hallucination_risk: 'HIGH',
    evidence_map: { paragraphs: [{ evidence: [] }] },
  });

  assert.equal(result.approved, false);
  assert.ok(result.failures.length >= 2);
});
