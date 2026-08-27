const NEGATIVE_EMOTIONS = ['medo', 'tristeza', 'raiva', 'culpa', 'vergonha', 'insegurança', 'solidão', 'dor'];
const POSITIVE_EMOTIONS = ['coragem', 'alegria', 'paz', 'confiança', 'orgulho', 'esperança', 'amor', 'alívio'];
const TRANSITION_MARKERS = ['mas', 'depois', 'até que', 'então', 'a partir dali', 'com o tempo', 'aprendi'];

class EmotionalTransitionDetector {
  detect({ memory = {}, signals = [] } = {}) {
    const text = [memory.title, memory.content, memory.refined_content, memory.transcription]
      .filter(Boolean).join(' ').toLowerCase();
    const from = NEGATIVE_EMOTIONS.filter((marker) => text.includes(marker));
    const to = POSITIVE_EMOTIONS.filter((marker) => text.includes(marker));
    const transitions = TRANSITION_MARKERS.filter((marker) => text.includes(marker));
    const signalBoost = signals.filter((signal) => signal.type === 'EMOTION' || signal.type === 'CHANGE').length;
    const score = Math.min(1, (from.length * 0.12) + (to.length * 0.12) + (transitions.length * 0.11) + (signalBoost * 0.08));
    return {
      detector: 'EmotionalTransitionDetector',
      detected: (from.length > 0 && to.length > 0) || score >= 0.34,
      score,
      markers: [...from, ...to, ...transitions],
      reason: from.length && to.length ? 'A memória sugere passagem emocional.' : 'Sem transição emocional completa.',
    };
  }
}
module.exports = { EmotionalTransitionDetector, NEGATIVE_EMOTIONS, POSITIVE_EMOTIONS, TRANSITION_MARKERS };
