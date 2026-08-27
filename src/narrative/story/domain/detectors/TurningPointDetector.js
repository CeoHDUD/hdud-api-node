const TURNING_POINT_MARKERS = [
  'naquele dia', 'a partir dali', 'nunca mais', 'foi quando', 'mudou tudo',
  'decisão', 'decidi', 'rompi', 'comecei', 'terminei', 'nasceu', 'morreu',
  'fui embora', 'voltei', 'abandonei', 'assumi', 'percebi'
];

class TurningPointDetector {
  detect({ memory = {}, signals = [] } = {}) {
    const text = [memory.title, memory.content, memory.refined_content, memory.transcription]
      .filter(Boolean).join(' ').toLowerCase();
    const markers = TURNING_POINT_MARKERS.filter((marker) => text.includes(marker));
    const signalBoost = signals.filter((signal) => ['DECISION', 'CHANGE', 'LOSS', 'ACHIEVEMENT'].includes(signal.type)).length;
    const score = Math.min(1, (markers.length * 0.2) + (signalBoost * 0.11));
    return {
      detector: 'TurningPointDetector',
      detected: score >= 0.25,
      score,
      markers,
      reason: markers.length ? 'A memória possui indícios de ponto de virada.' : 'Sem ponto de virada explícito.',
    };
  }
}
module.exports = { TurningPointDetector, TURNING_POINT_MARKERS };
