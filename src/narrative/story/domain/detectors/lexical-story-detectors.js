const { StorySignalType } = require('../value-objects/StorySignal');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function includesAny(text, terms = []) {
  return terms.some((term) => text.includes(normalizeText(term)));
}

const LEXICAL_STORY_DETECTORS = Object.freeze([
  {
    type: StorySignalType.CHANGE,
    strength: 0.85,
    source: 'lexical_change',
    reason: 'A memória contém indícios de mudança, recomeço ou virada narrativa.',
    terms: ['mudanca', 'mudei', 'mudou', 'transformou', 'virada', 'recomeco', 'novo caminho', 'nova fase'],
  },
  {
    type: StorySignalType.DECISION,
    strength: 0.78,
    source: 'lexical_decision',
    reason: 'A memória contém indícios de escolha, decisão ou assunção de responsabilidade.',
    terms: ['decidi', 'decisao', 'escolhi', 'resolvi', 'abandonei', 'assumi', 'optei'],
  },
  {
    type: StorySignalType.EMOTION,
    strength: 0.65,
    source: 'lexical_emotion',
    reason: 'A memória contém carga emocional relevante.',
    terms: ['medo', 'dor', 'alegria', 'culpa', 'orgulho', 'saudade', 'tristeza', 'raiva', 'ansiedade'],
  },
  {
    type: StorySignalType.RELATIONSHIP,
    strength: 0.62,
    source: 'lexical_relationship',
    reason: 'A memória envolve vínculos humanos relevantes.',
    terms: ['pai', 'mae', 'filho', 'filha', 'esposa', 'marido', 'amigo', 'familia', 'irmao', 'irma'],
  },
  {
    type: StorySignalType.PURPOSE,
    strength: 0.8,
    source: 'lexical_purpose',
    reason: 'A memória aponta para propósito, missão, sentido ou legado.',
    terms: ['proposito', 'missao', 'sentido', 'legado', 'vocacao', 'chamado'],
  },
  {
    type: StorySignalType.CONFLICT,
    strength: 0.74,
    source: 'lexical_conflict',
    reason: 'A memória contém tensão, ruptura, perda de estabilidade ou conflito.',
    terms: ['conflito', 'briga', 'perdi', 'demissao', 'ruptura', 'problema', 'crise', 'dificuldade'],
  },
  {
    type: StorySignalType.IDENTITY,
    strength: 0.88,
    source: 'lexical_identity',
    reason: 'A memória sugere mudança de identidade ou percepção de si.',
    terms: ['me tornei', 'eu era', 'sou hoje', 'identidade', 'quem eu sou', 'quem eu era'],
  },
  {
    type: StorySignalType.ACHIEVEMENT,
    strength: 0.7,
    source: 'lexical_achievement',
    reason: 'A memória contém conquista, realização ou superação.',
    terms: ['conquista', 'vitoria', 'realizei', 'consegui', 'superacao', 'alcancei'],
  },
  {
    type: StorySignalType.LOSS,
    strength: 0.82,
    source: 'lexical_loss',
    reason: 'A memória contém perda, luto, despedida ou ausência significativa.',
    terms: ['perda', 'morte', 'luto', 'despedida', 'ausencia', 'saudade'],
  },
  {
    type: StorySignalType.VALUE,
    strength: 0.68,
    source: 'lexical_value',
    reason: 'A memória contém aprendizado, valor pessoal ou princípio de vida.',
    terms: ['valor', 'aprendi', 'ensinou', 'verdade', 'principio', 'licao'],
  },
]);

function runLexicalStoryDetectors(text) {
  const normalizedText = normalizeText(text);

  return LEXICAL_STORY_DETECTORS.filter((detector) => (
    includesAny(normalizedText, detector.terms)
  ));
}

module.exports = {
  LEXICAL_STORY_DETECTORS,
  normalizeText,
  includesAny,
  runLexicalStoryDetectors,
};
