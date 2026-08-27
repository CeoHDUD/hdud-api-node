class StorySplitter {
  splitIfNeeded(hypothesis = {}) {
    const memories = hypothesis.relatedMemories || [];
    const evidence = hypothesis.evidence || [];
    const dominantReasons = new Set(evidence.map((item) => String(item.reason || '').slice(0, 32)));
    if (memories.length < 6 || dominantReasons.size <= 4) return [hypothesis];
    return [hypothesis];
  }
}
module.exports = { StorySplitter };
