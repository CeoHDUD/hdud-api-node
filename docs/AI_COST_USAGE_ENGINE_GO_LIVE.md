# GO LIVE — AI Cost & Usage Engine

## Regra econômica congelada

`Save Memory -> External AI = 0`

MEI, NTG e Local Classification Engine permanecem locais por padrão. A chamada externa do MEI só existe no caminho explicitamente opt-in `useExternalAi === true`.

## Instalação de banco

Executar antes de validar a nova telemetria:

`src/db/migrations/20260811_ai_cost_usage_engine.sql`

A migration é aditiva e cria:

- `dbo.ai_cost_model_rate`
- `dbo.ai_usage_ledger`
- `dbo.subscription_plan_ai_policy`

Planos existentes são inseridos em `subscription_plan_ai_policy` com orçamento `NULL` e `hard_stop = 0`, preservando o comportamento atual até a homologação comercial das quotas econômicas.

## Operações instrumentadas

- AUDIO_TRANSCRIPTION
- AUDIO_EDITORIAL_REFINE
- MEMORY_EDITORIAL_REFINE
- STORY_GENERATION
- CHAPTER_EDITORIAL_GENERATION
- EDITORIAL_MANUSCRIPT_GENERATION
- MEI_EXTERNAL_REGENERATE (somente opt-in explícito)
- NARRATIVE_ENTITY_EXTRACTION
- NARRATIVE_RELATIONSHIP_EXTRACTION
- NARRATIVE_TIMELINE_EXTRACTION
- NARRATIVE_CHAPTER_GENERATION
- NARRATIVE_CHAPTER_ORCHESTRATION
- VOICE_PROFILE_GENERATION
- STORY_TRUTH_GENERATION

## API

`GET /api/me/ai-usage`

Retorna consumo externo do ciclo da assinatura, custo USD, tokens, segundos de áudio, orçamento econômico e agregação por operação.

## Proteção de margem

Quando `subscription_plan_ai_policy.monthly_external_ai_budget_usd` estiver definido e `hard_stop = 1`, chamadas externas são bloqueadas antes de chegar ao provider ao atingir o orçamento do ciclo.

O ledger é fail-open para observabilidade: indisponibilidade da tabela de telemetria não derruba o fluxo editorial. O hard-stop, quando explicitamente configurado, é fail-closed para novas chamadas externas.

## Validação realizada

- `node --check` em todos os arquivos `.js` do backend: OK.
- `node --test src/tests/mei-local-classifier.regression.test.js`: 10/10 casos OK.
- Frontend `PlansPage.tsx`: parser TypeScript não apresentou erro sintático; a checagem isolada reporta apenas dependências React não presentes no ZIP de `src` fornecido.
