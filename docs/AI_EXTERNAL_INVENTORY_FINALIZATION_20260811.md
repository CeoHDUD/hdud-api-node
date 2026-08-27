# HDUD — AI Cost & Usage Engine — Inventário Externo

Data: 2026-08-11
Status: auditoria estática + hardening de atribuição econômica

## Congelado / homologado

- Save Memory / MEI / NTG / Local Classification Engine V2: custo externo zero no fluxo normal.
- AUDIO_TRANSCRIPTION: ledger, duração, custo e usuário homologados.
- AUDIO_EDITORIAL_REFINE: ledger e tokens homologados.
- STORY_GENERATION: ledger, tokens, custo e usuário homologados.
- CHAPTER_EDITORIAL_GENERATION: ledger, tokens, custo e usuário homologados após propagação explícita de userId.

## Hardening desta entrega

O AI Cost & Usage Engine continua priorizando `userId` quando o fluxo o fornece explicitamente. Para serviços legados/assíncronos que ainda conhecem apenas `authorId`, a resolução deixou de escolher o menor `user_id` histórico. O fallback agora prioriza o `identity_user` que possui assinatura ACTIVE mais recente; sem assinatura, usa o `identity_user` mais novo.

Nenhum registro histórico do ledger foi alterado.

## Superfície externa encontrada no backend

Todos os pontos diretos encontrados para o SDK OpenAI passam pelo AI Cost & Usage Engine (`assertExternalAIAllowed` + `recordExternalAIUsage`). Não foi encontrada chamada direta OpenAI completamente fora do ledger.

Operações encontradas:

| operation_code | origem principal | rota/fluxo estático | situação |
|---|---|---|---|
| AUDIO_TRANSCRIPTION | workers/memory-audio.worker.js | pipeline de áudio | HOMOLOGADO |
| AUDIO_EDITORIAL_REFINE | routes/memory.js + memory-refiner | refino de áudio | HOMOLOGADO |
| STORY_GENERATION | story-generation.service.js -> generative | composição de história | HOMOLOGADO |
| CHAPTER_EDITORIAL_GENERATION | chapter-editorial.service.js | gerar novo manuscrito de capítulo | HOMOLOGADO |
| MEMORY_EDITORIAL_REFINE | memory-refiner.service.js | /api/narrative/refine-memory e rotas de memória | rota registrada; requer classificação de fluxo vivo |
| MEI_EXTERNAL_REGENERATE | memory-editorial-intelligence.service.js | regeneração editorial explícita | rota existente; fluxo normal de Save Memory permanece local |
| NARRATIVE_CHAPTER_GENERATION | openai-narrative.service.js | POST /api/narrative/generate-chapter | rota registrada; sem referência direta encontrada no frontend atual |
| VOICE_PROFILE_GENERATION | voice-profile.service.js | POST /api/narrative/build-voice-profile | rota registrada; sem referência direta encontrada no frontend atual |
| NARRATIVE_ENTITY_EXTRACTION | entity-extraction.service.js | POST /api/narrative/extract-entities | rota registrada; sem referência direta encontrada no frontend atual |
| NARRATIVE_TIMELINE_EXTRACTION | timeline-extraction.service.js | POST /api/narrative/extract-timeline | rota registrada; sem referência direta encontrada no frontend atual |
| NARRATIVE_RELATIONSHIP_EXTRACTION | relationship-extraction.service.js | POST /api/narrative/extract-relationships | rota registrada; sem referência direta encontrada no frontend atual |
| NARRATIVE_CHAPTER_ORCHESTRATION | chapter-orchestrator.service.js | POST /api/narrative/orchestrate-chapter | rota registrada; sem referência direta encontrada no frontend atual |
| STORY_TRUTH_GENERATION | StoryTruthOpenAIAdapter.js | Story Truth runtime | backend disponível; confirmar acionamento real antes de homologar economicamente |
| EDITORIAL_MANUSCRIPT_GENERATION | generative-openai.service.js | fallback/default do gerador editorial | infraestrutura compartilhada; normalmente sobrescrito por operationCode específico |

## Regra para próxima homologação

Não disparar operações externas apenas porque existem no source. Primeiro provar que o endpoint está conectado a uma experiência viva do produto; depois executar uma única chamada real e conferir `user_id`, `author_id`, `operation_code`, modelo snapshot, tokens e custo no ledger e no Plano & Uso.
