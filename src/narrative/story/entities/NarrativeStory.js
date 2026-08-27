// C:\HDUD_DATA\hdud-api-node\src\narrative\story\entities\NarrativeStory.js

import crypto from "crypto";
import {
  StoryStatus,
  inferStoryStatusFromConfidence,
  isValidStoryStatus,
  normalizeStoryStatus,
} from "../value-objects/StoryStatus.js";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, fallback = "") {
  if (value == null) return fallback;

  const text = String(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.length ? text : fallback;
}

function normalizeConfidence(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  if (numericValue < 0) {
    return 0;
  }

  if (numericValue > 1) {
    return 1;
  }

  return Number(numericValue.toFixed(4));
}

function normalizeRelatedMemories(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];

  for (const item of source) {
    const memoryId = Number(
      item?.memory_id ??
        item?.memoryId ??
        item?.id ??
        item
    );

    if (!Number.isInteger(memoryId) || memoryId <= 0 || seen.has(memoryId)) {
      continue;
    }

    seen.add(memoryId);
    out.push(memoryId);
  }

  return out;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildStoryFingerprint({
  authorId,
  centralTheme,
  centralQuestion,
  relatedMemories,
}) {
  const ids = normalizeRelatedMemories(relatedMemories)
    .sort((a, b) => a - b)
    .join(",");

  const raw = [
    authorId,
    cleanText(centralTheme, "").toLowerCase(),
    cleanText(centralQuestion, "").toLowerCase(),
    ids,
  ].join("|");

  return crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex");
}

export class NarrativeStory {
  constructor({
    storyId = null,
    authorId,
    status = null,
    centralTheme = "",
    centralQuestion = "",
    summary = "",
    confidence = 0,
    relatedMemories = [],
    evidence = [],
    mainTransformation = "",
    source = "story_discovery",
    sourceHypothesis = null,
    fingerprint = null,
    createdAt = nowIso(),
    updatedAt = nowIso(),
  } = {}) {
    const safeAuthorId = Number(authorId);

    if (!Number.isInteger(safeAuthorId) || safeAuthorId <= 0) {
      throw new Error("NarrativeStory requires a valid authorId.");
    }

    const normalizedConfidence = normalizeConfidence(confidence);
    const normalizedStatus = status
      ? normalizeStoryStatus(status, inferStoryStatusFromConfidence(normalizedConfidence))
      : inferStoryStatusFromConfidence(normalizedConfidence);

    if (!isValidStoryStatus(normalizedStatus)) {
      throw new Error(`Invalid NarrativeStory status: ${status}`);
    }

    this.storyId =
      storyId ||
      `story_${crypto.randomUUID()}`;

    this.authorId = safeAuthorId;
    this.status = normalizedStatus;
    this.centralTheme = cleanText(centralTheme, "História emergente");
    this.centralQuestion = cleanText(
      centralQuestion,
      "Que história humana estas memórias estão tentando revelar?"
    );
    this.summary = cleanText(summary, "");
    this.confidence = normalizedConfidence;
    this.relatedMemories = normalizeRelatedMemories(relatedMemories);
    this.evidence = normalizeArray(evidence);
    this.mainTransformation = cleanText(mainTransformation, "");
    this.source = cleanText(source, "story_discovery");
    this.sourceHypothesis = sourceHypothesis || null;
    this.fingerprint =
      fingerprint ||
      buildStoryFingerprint({
        authorId: this.authorId,
        centralTheme: this.centralTheme,
        centralQuestion: this.centralQuestion,
        relatedMemories: this.relatedMemories,
      });
    this.createdAt = createdAt || nowIso();
    this.updatedAt = updatedAt || nowIso();
  }

  isMature() {
    return (
      this.status === StoryStatus.MATURE ||
      this.status === StoryStatus.VALIDATED ||
      this.status === StoryStatus.EDITORIAL_READY ||
      this.status === StoryStatus.ACCEPTED
    );
  }

  canBecomeChapter() {
    return (
      this.status === StoryStatus.EDITORIAL_READY ||
      this.status === StoryStatus.ACCEPTED
    );
  }

  withStatus(status) {
    return new NarrativeStory({
      ...this.toJSON(),
      status,
      updatedAt: nowIso(),
    });
  }

  toHypothesis() {
    return {
      story_id: this.storyId,
      storyId: this.storyId,
      status: this.status,
      confidence: this.confidence,
      title: this.centralTheme,
      suggested_title: this.centralTheme,
      summary: this.summary,
      description: this.summary,
      related_memories: this.relatedMemories,
      relatedMemories: this.relatedMemories,
      main_transformation: this.mainTransformation,
      mainTransformation: this.mainTransformation,
      central_question: this.centralQuestion,
      mainQuestion: this.centralQuestion,
      evidence: this.evidence,
      source: this.source,
      fingerprint: this.fingerprint,
    };
  }

  toJSON() {
    return {
      storyId: this.storyId,
      story_id: this.storyId,
      authorId: this.authorId,
      author_id: this.authorId,
      status: this.status,
      centralTheme: this.centralTheme,
      central_theme: this.centralTheme,
      centralQuestion: this.centralQuestion,
      central_question: this.centralQuestion,
      summary: this.summary,
      confidence: this.confidence,
      relatedMemories: this.relatedMemories,
      related_memories: this.relatedMemories,
      evidence: this.evidence,
      mainTransformation: this.mainTransformation,
      main_transformation: this.mainTransformation,
      source: this.source,
      sourceHypothesis: this.sourceHypothesis,
      source_hypothesis: this.sourceHypothesis,
      fingerprint: this.fingerprint,
      createdAt: this.createdAt,
      created_at: this.createdAt,
      updatedAt: this.updatedAt,
      updated_at: this.updatedAt,
    };
  }

  static fromHypothesis(hypothesis = {}, options = {}) {
    const authorId =
      options.authorId ??
      hypothesis.author_id ??
      hypothesis.authorId;

    const relatedMemories =
      hypothesis.related_memories ??
      hypothesis.relatedMemories ??
      hypothesis.memory_ids ??
      hypothesis.memories ??
      [];

    return new NarrativeStory({
      storyId: hypothesis.story_id ?? hypothesis.storyId ?? null,
      authorId,
      status: hypothesis.status ?? null,
      centralTheme:
        hypothesis.central_theme ??
        hypothesis.centralTheme ??
        hypothesis.suggested_title ??
        hypothesis.title ??
        "História emergente",
      centralQuestion:
        hypothesis.central_question ??
        hypothesis.centralQuestion ??
        hypothesis.mainQuestion ??
        hypothesis.main_question ??
        "Que história humana estas memórias estão tentando revelar?",
      summary:
        hypothesis.summary ??
        hypothesis.description ??
        "",
      confidence: hypothesis.confidence ?? 0,
      relatedMemories,
      evidence: hypothesis.evidence ?? [],
      mainTransformation:
        hypothesis.main_transformation ??
        hypothesis.mainTransformation ??
        "",
      source: hypothesis.engine ?? hypothesis.source ?? "story_discovery_orchestrator",
      sourceHypothesis: hypothesis,
      fingerprint: hypothesis.fingerprint ?? null,
      createdAt: hypothesis.created_at ?? hypothesis.createdAt ?? nowIso(),
      updatedAt: hypothesis.updated_at ?? hypothesis.updatedAt ?? nowIso(),
    });
  }
}

export {
  buildStoryFingerprint,
  normalizeConfidence,
};
