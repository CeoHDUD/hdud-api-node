// C:\HDUD_DATA\hdud-api-node\src\services\chapters\chapter-suggestion.service.js

import { buildStoryHypothesisFromCluster } from "../story/story-discovery-orchestrator.service.js";

export function suggestChapterFromCluster(cluster, options = {}) {
  const story = buildStoryHypothesisFromCluster(cluster, options);

  if (!story) return null;

  return suggestChapterFromStoryHypothesis(story);
}

export function suggestChapterFromStoryHypothesis(story) {
  if (!story) return null;

  const relatedMemories = Array.isArray(story.related_memories)
    ? story.related_memories
    : Array.isArray(story.relatedMemories)
      ? story.relatedMemories
      : [];

  const confidence = Number.isFinite(Number(story.confidence))
    ? Math.max(0.35, Math.min(0.95, Number(story.confidence)))
    : 0.6;

  return {
    suggested_title:
      story.suggested_title ||
      story.title ||
      story.central_theme ||
      "Uma história da sua vida",
    description:
      story.description ||
      story.summary ||
      buildDescriptionFromStory(story, relatedMemories),
    confidence,
    source: "story_hypothesis",
    story_hypothesis: {
      story_id: story.story_id || story.storyId || null,
      status: story.status || null,
      central_theme: story.central_theme || null,
      central_theme_code: story.central_theme_code || null,
      central_question: story.central_question || story.mainQuestion || null,
      main_transformation: story.main_transformation || story.mainTransformation || null,
      related_memories: relatedMemories,
      evidence: Array.isArray(story.evidence) ? story.evidence : [],
      keywords: Array.isArray(story.keywords) ? story.keywords : [],
      engine: story.engine || null,
      generated_at: story.generated_at || null,
    },
  };
}

function buildDescriptionFromStory(story, relatedMemories) {
  const count = relatedMemories.length;
  const theme = story.central_theme || story.main_transformation || "uma transformação humana";

  if (count <= 0) {
    return `Este capítulo nasce de uma hipótese narrativa sobre ${String(theme).toLowerCase()}.`;
  }

  if (count === 1) {
    return `Este capítulo nasce de uma memória com forte sinal narrativo sobre ${String(theme).toLowerCase()}.`;
  }

  return `Este capítulo nasce de ${count} memórias que parecem contar a mesma história sobre ${String(theme).toLowerCase()}.`;
}
