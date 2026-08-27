// C:\HDUD_DATA\hdud-api-node\src\narrative\story\value-objects\StoryStatus.js

export const StoryStatus = Object.freeze({
  DISCOVERING: "DISCOVERING",
  EMERGING: "EMERGING",
  MATURE: "MATURE",
  VALIDATED: "VALIDATED",
  EDITORIAL_READY: "EDITORIAL_READY",
  ACCEPTED: "ACCEPTED",
  DISCARDED: "DISCARDED",
  SNOOZED: "SNOOZED",
  CONVERTED_TO_CHAPTER: "CONVERTED_TO_CHAPTER",
});

export const AUTHOR_DECISION_STORY_STATUSES = Object.freeze([
  StoryStatus.ACCEPTED,
  StoryStatus.DISCARDED,
  StoryStatus.SNOOZED,
  StoryStatus.CONVERTED_TO_CHAPTER,
]);

export function isValidStoryStatus(status) {
  return Object.values(StoryStatus).includes(status);
}

export function isAuthorDecisionStatus(status) {
  return AUTHOR_DECISION_STORY_STATUSES.includes(status);
}

export function normalizeStoryStatus(status, fallback = StoryStatus.DISCOVERING) {
  const value = String(status || "").trim().toUpperCase();

  if (isValidStoryStatus(value)) {
    return value;
  }

  return fallback;
}

export function inferStoryStatusFromConfidence(confidence) {
  const score = Number(confidence);

  if (!Number.isFinite(score)) {
    return StoryStatus.DISCOVERING;
  }

  if (score >= 0.86) {
    return StoryStatus.EDITORIAL_READY;
  }

  if (score >= 0.72) {
    return StoryStatus.MATURE;
  }

  if (score >= 0.5) {
    return StoryStatus.EMERGING;
  }

  return StoryStatus.DISCOVERING;
}
