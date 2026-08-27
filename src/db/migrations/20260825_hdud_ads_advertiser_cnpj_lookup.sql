USE HDUD_CORE;
GO

/*
HDUD Ads — Anunciantes | Consulta cadastral por CNPJ

Esta migration NÃO cria nova tabela nem coluna.
A consulta externa é apenas enriquecimento no momento do cadastro.
Depois do operador confirmar e salvar, dbo.ads_advertiser continua sendo a fonte operacional da verdade.
*/

SET XACT_ABORT ON;
BEGIN TRAN;

UPDATE dbo.platform_capability_registry
SET
    current_state = 'Advertiser Core homologado com CNPJ canônico em tax_id e fluxo administrativo de pré-cadastro por consulta CNPJ via Backend HDUD. O backend valida o CNPJ, verifica duplicidade no HDUD_CORE, consulta provider externo de forma controlada e normaliza nome, razão social, situação cadastral, e-mail e telefone para conferência do operador antes do INSERT.',
    target_state = 'Manter dbo.ads_advertiser como fonte operacional da verdade. Consulta cadastral externa permanece apenas como enriquecimento de pré-cadastro, sem persistência paralela, sem consulta direta pelo navegador e sem converter situação fiscal externa em status operacional HDUD.',
    decision_reason = 'O operador não deve redigitar dados cadastrais públicos que podem ser consultados pelo CNPJ. A integração fica encapsulada no backend para permitir controle de RBAC, timeout, auditoria, troca futura de provider e proteção contra duplicidade.',
    notes = CONCAT(
        COALESCE(NULLIF(notes, '') + ' ', ''),
        'Consulta CNPJ: endpoint administrativo read-through protegido por ADS_WRITE; provider inicial BrasilAPI; sem cache/tabela paralela; situação cadastral externa é informativa e independente de status_code da HDUD.'
    ),
    updated_at = SYSUTCDATETIME()
WHERE domain_code = 'HDUD_ADS'
  AND capability_code = 'ADVERTISER_CORE';

COMMIT;
GO

SELECT
    capability_id,
    domain_code,
    capability_code,
    status_code,
    implementation_phase,
    current_state,
    target_state,
    decision_reason,
    notes,
    updated_at
FROM dbo.platform_capability_registry
WHERE domain_code = 'HDUD_ADS'
  AND capability_code = 'ADVERTISER_CORE';
GO
