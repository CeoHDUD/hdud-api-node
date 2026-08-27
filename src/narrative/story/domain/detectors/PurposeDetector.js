const PURPOSE_MARKERS = [
  'propósito', 'missão', 'sentido', 'vocação', 'chamado', 'sonho', 'objetivo',
  'decidi que', 'percebi que precisava', 'entendi que', 'descobri que queria',
  'era isso que eu queria', 'minha missão', 'meu caminho', 'meu lugar'
];

class PurposeDetector {
  detect({ memory = {}, signals = [] } = {}) {
    const text = [memory.title, memory.content, memory.refined_content, memory.transcription]
      .filter(Boolean).join(' ').toLowerCase();
    const matches = PURPOSE_MARKERS.filter((marker) => text.includes(marker));
    const signalBoost = signals.filter((signal) => signal.type === 'PURPOSE' || signal.type === 'VALUE').length;
    const score = Math.min(1, (matches.length * 0.22) + (signalBoost * 0.12));
    return {
      detector: 'PurposeDetector',
      detected: score >= 0.22,
      score,
      markers: matches,
      reason: matches.length ? 'A memória sugere busca ou descoberta de propósito.' : 'Sem evidência forte de propósito.',
    };
  }
}
module.exports = { PurposeDetector, PURPOSE_MARKERS };
