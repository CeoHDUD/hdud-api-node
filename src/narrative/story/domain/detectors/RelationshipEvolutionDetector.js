const RELATIONSHIP_MARKERS = [
  'pai', 'mãe', 'filho', 'filha', 'irmão', 'irmã', 'esposa', 'marido', 'namoro',
  'casamento', 'amigo', 'amizade', 'chefe', 'colega', 'família', 'professor',
  'mentor', 'conheci', 'reencontrei', 'nos afastamos', 'nos aproximamos'
];
const EVOLUTION_MARKERS = ['antes', 'depois', 'mudou', 'aproximou', 'afastou', 'perdoei', 'entendi', 'reconciliei'];

class RelationshipEvolutionDetector {
  detect({ memory = {}, signals = [] } = {}) {
    const text = [memory.title, memory.content, memory.refined_content, memory.transcription]
      .filter(Boolean).join(' ').toLowerCase();
    const relationships = RELATIONSHIP_MARKERS.filter((marker) => text.includes(marker));
    const evolution = EVOLUTION_MARKERS.filter((marker) => text.includes(marker));
    const signalBoost = signals.filter((signal) => signal.type === 'RELATIONSHIP').length;
    const score = Math.min(1, (relationships.length * 0.12) + (evolution.length * 0.16) + (signalBoost * 0.1));
    return {
      detector: 'RelationshipEvolutionDetector',
      detected: relationships.length > 0 && score >= 0.18,
      score,
      markers: [...relationships, ...evolution],
      reason: relationships.length ? 'A memória envolve relação humana com possível evolução.' : 'Sem relação humana dominante.',
    };
  }
}
module.exports = { RelationshipEvolutionDetector, RELATIONSHIP_MARKERS, EVOLUTION_MARKERS };
