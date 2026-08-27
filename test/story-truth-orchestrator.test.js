import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryTruthPipeline } from '../src/services/story-truth/index.js';
import { StoryTruthContext } from '../src/services/story-truth/index.js';

test('StoryTruthPipeline generates truth report and manuscript', async () => {
  const context = new StoryTruthContext({
    storyId: 1,
    authorId: 1,
    candidate: { id: 1, title: 'História da Escola', summary: 'escola família portão' },
    memories: [
      {
        memory_id: 101,
        title: 'A escola',
        content: 'Eu estudava perto de casa e lembro da minha família me esperando no portão da escola.',
      },
    ],
  });

  const pipeline = new StoryTruthPipeline({
    generateWithAI: async () => ({
      title: 'História da Escola',
      manuscript: [
        {
          paragraph_index: 1,
          text: 'Eu estudava perto de casa e minha família me esperava no portão da escola.',
          evidence_memory_ids: [101],
          truth_notes: ['A memória 101 sustenta o parágrafo.'],
        },
      ],
      warnings: [],
    }),
  });

  await pipeline.execute(context);

  assert.ok(context.truthReport);
  assert.ok(context.evidenceMap);
  assert.ok(context.manuscript.includes('portão da escola'));
  assert.ok(context.truthReport.truth_score >= 0);
});
