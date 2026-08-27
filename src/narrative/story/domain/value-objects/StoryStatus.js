const StoryStatus = Object.freeze({
  DISCOVERING: 'DISCOVERING',
  EMERGING: 'EMERGING',
  MATURE: 'MATURE',
  VALIDATED: 'VALIDATED',
  EDITORIAL_READY: 'EDITORIAL_READY',
});

function isValidStoryStatus(status) {
  return Object.values(StoryStatus).includes(status);
}

module.exports = {
  StoryStatus,
  isValidStoryStatus,
};
