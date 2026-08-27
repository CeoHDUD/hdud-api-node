const CONSEQUENCE_MARKERS = [
  'por isso', 'desde então', 'como consequência', 'isso fez com que', 'a partir disso',
  'por causa disso', 'resultado', 'me levou', 'me obrigou', 'me ensinou', 'mudei'
];

class ConsequenceDetector {
  detect({ memory = {}, signals = [] } = {}) {
    const text = [memory.title, memory.content, memory.refined_content, memory.transcription]
      .filter(Boolean).join(' ').toLowerCase();
    const markers = CONSEQUENCE_MARKERS.filter((marker) => text.includes(marker));
    const signalBoost = signals.filter((signal) => ['CHANGE', 'DECISION', 'ACHIEVEMENT'].includes(signal.type)).length;
    const score = Math.min(1, (markers.length * 0.22) + (signalBoost * 0.08));
    return {
      detector: 'ConsequenceDetector',
      detected: score >= 0.22,
      score,
      markers,
      reason: markers.length ? 'A memória explicita causa ou consequência.' : 'Sem consequência explícita.',
    };
  }
}
module.exports = { ConsequenceDetector, CONSEQUENCE_MARKERS };
