import assert from "node:assert/strict";
import { classifyLocalMemoryV2 } from "../services/mei/local-classifier.service.js";

const cases = [
  {
    name: "Mama",
    memory: { title: "Mama", content: "Minha mãe, dona Vera, foi uma mãe presente, bastante enérgica, e sou muito grato a ela porque, nos momentos difíceis, ela sempre estava ao meu lado. Estava sempre na correria, trabalhando para sustentar os três filhos e fazendo tudo o que estava ao seu alcance." },
    expected: { life_period_code: null, context_code: "FAMILY_AFFECTION", narrative_role_code: "REFLECTION", canonical_story_key: null },
  },
  {
    name: "Bangola",
    memory: { title: "Bangola", content: "Bangola, é a forma como o meu Pai é conhecido entre os amigos dele de baralho, todos os chamam desta forma e com o passar do tempo até eu mesmo comecei a usar o mesmo tratamento, meu pai se chama Alercio e cá entre nós Bangola tem uma pronuncia mais agradável." },
    expected: { life_period_code: null, context_code: "FAMILY", narrative_role_code: "CONTEXT", canonical_story_key: null },
  },
  {
    name: "Bruna",
    memory: { title: "Quando conheci a Bruna", content: "Foi a primeira vez que encontrei a Bruna. Aquele encontro marcou o começo do nosso relacionamento." },
    expected: { life_period_code: null, context_code: "LOVE", narrative_role_code: "ORIGIN", canonical_story_key: null },
  },
  {
    name: "HDUD",
    memory: { title: "HDUD", content: "Durante uma internação percebi que queria preservar minha história. Foi assim que nasceu a ideia da plataforma HDUD." },
    expected: { life_period_code: null, context_code: "HDUD", narrative_role_code: "DISCOVERY", canonical_story_key: null },
  },
  {
    name: "Paternidade",
    memory: { title: "Meu filho", content: "Meu filho mudou a forma como eu enxergava a vida. Tenho muito orgulho e carinho pela nossa relação." },
    expected: { life_period_code: null, context_code: "PARENT_CHILD_BOND", narrative_role_code: "REFLECTION", canonical_story_key: null },
  },
  {
    name: "Infância",
    memory: { title: "Infância", content: "Na minha infância eu brincava na rua até escurecer." },
    expected: { life_period_code: "CHILDHOOD", context_code: "CHILDHOOD", narrative_role_code: "CONTEXT", canonical_story_key: null },
  },
  {
    name: "Educação",
    memory: { title: "Escola", content: "Na escola tive professores que fizeram parte da minha formação." },
    expected: { life_period_code: null, context_code: "EDUCATION", narrative_role_code: "CONTEXT", canonical_story_key: null },
  },
  {
    name: "Trabalho",
    memory: { title: "Trabalho", content: "Minha carreira como DBA começou trabalhando com SQL Server em uma empresa de tecnologia." },
    expected: { life_period_code: null, context_code: "WORK", narrative_role_code: "CONTEXT", canonical_story_key: null },
  },
  {
    name: "Saúde",
    memory: { title: "Saúde", content: "Passei por uma cirurgia e fiquei internado no hospital durante o tratamento." },
    expected: { life_period_code: null, context_code: "HEALTH", narrative_role_code: "CRISIS", canonical_story_key: null },
  },
  {
    name: "Sem evidência",
    memory: { title: "Uma lembrança", content: "Era uma tarde comum e eu fiquei olhando pela janela." },
    expected: { life_period_code: null, context_code: null, narrative_role_code: null, canonical_story_key: null },
  },
];

for (const tc of cases) {
  const actual = classifyLocalMemoryV2(tc.memory);
  for (const [key, expected] of Object.entries(tc.expected)) {
    assert.equal(actual[key], expected, `${tc.name}: ${key} esperado=${expected} obtido=${actual[key]}`);
  }
  assert.equal(actual.canonical_story_title, null, `${tc.name}: canonical_story_title deve ser NULL`);
  assert.equal(actual.narrative_arc_code, null, `${tc.name}: narrative_arc_code deve ser NULL`);
  assert.equal(actual.interpretation_source, "AI_LOCAL", `${tc.name}: deve permanecer local`);
  assert.equal(actual.classified_by, "HDUD_LOCAL", `${tc.name}: classified_by incorreto`);
}

console.log(`MEI Local Regression: ${cases.length}/${cases.length} casos OK`);
