const CONFLICT_MARKERS = [
  'conflito', 'briga', 'dor', 'medo', 'dúvida', 'culpa', 'perdi', 'perda',
  'demissão', 'fracasso', 'quase desisti', 'não consegui', 'difícil', 'crise',
  'ruptura', 'abandono', 'trauma', 'problema', 'luta', 'desafio'
];

class ConflictDetector {
  detect({ memory = {}, signals = [] } = {}) {
    const text = [memory.title, memory.content, memory.refined_content, memory.transcription]
      .filter(Boolean).join(' ').toLowerCase();
    const markers = CONFLICT_MARKERS.filter((marker) => text.includes(marker));
    const signalBoost = signals.filter((signal) => ['CONFLICT', 'LOSS', 'CHANGE'].includes(signal.type)).length;
    const score = Math.min(1, (markers.length * 0.18) + (signalBoost * 0.12));
    return {
      detector: 'ConflictDetector',
      detected: score >= 0.2,
      score,
      markers,
      reason: markers.length ? 'A memória contém tensão narrativa ou conflito.' : 'Sem conflito narrativo evidente.',
    };
  }
}
module.exports = { ConflictDetector, CONFLICT_MARKERS };
