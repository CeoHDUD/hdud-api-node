import { getPool } from '../../db.js';
import { StoryTruthContext } from './StoryTruthContext.js';
import { StoryTruthPersistence } from './StoryTruthPersistence.js';
import { StoryTruthPipeline } from './StoryTruthPipeline.js';
import { StoryTruthRuntime } from './StoryTruthRuntime.js';

export class StoryTruthOrchestrator {
  constructor({ pool = null, generateWithAI = null } = {}) {
    this.pool = pool;
    this.generateWithAI = generateWithAI;
  }

  async generateStory({ storyId, authorId, language = 'pt-BR', requestId = null } = {}) {
    const pool = this.pool || await getPool();
    const persistence = new StoryTruthPersistence(pool);

    const candidate = await persistence.loadCandidate({ storyId, authorId });
    if (!candidate) {
      const error = new Error('STORY_CANDIDATE_NOT_FOUND');
      error.status = 404;
      throw error;
    }

    const memories = await persistence.loadMemories({ storyId, authorId });
    if (!memories.length) {
      const error = new Error('STORY_HAS_NO_MEMORIES');
      error.status = 422;
      throw error;
    }

    const previousVersions = await persistence.loadPreviousVersions({ storyId, authorId });

    const context = new StoryTruthContext({
      storyId,
      authorId,
      candidate,
      memories,
      previousVersions,
      language,
      requestId,
    });

    const pipeline = new StoryTruthPipeline({ generateWithAI: this.generateWithAI });
    const runtime = new StoryTruthRuntime({ persistence });

    await pipeline.execute(context);
    await runtime.persist(context);

    return {
      story_id: context.storyId,
      version: context.version,
      manuscript: context.manuscript,
      truth_report: context.truthReport,
      evidence_map: context.evidenceMap,
      lineage: context.lineage,
      author_sovereignty: context.authorSovereignty,
      warnings: context.warnings,
    };
  }
}
