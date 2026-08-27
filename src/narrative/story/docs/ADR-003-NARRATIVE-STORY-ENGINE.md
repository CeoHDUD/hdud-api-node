# ADR-003 — Narrative Story Engine

## Decisão

Criar um domínio isolado para descoberta de histórias humanas em `src/narrative/story`.

## Motivo

Clusterização não é suficiente para representar transformação humana.
A HDUD precisa reconhecer histórias antes de sugerir capítulos.

## Consequências

- Chapter Engine deixa de ser motor de descoberta.
- Story Engine passa a produzir hipóteses narrativas.
- Integração com rotas e banco fica para etapa posterior.
