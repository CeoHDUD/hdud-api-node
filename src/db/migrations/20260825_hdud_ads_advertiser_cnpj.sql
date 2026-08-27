USE HDUD_CORE;
GO

/*
HDUD Ads — Anunciantes | CNPJ
Objetivo:
  - manter dbo.ads_advertiser.tax_id como fonte única do identificador fiscal;
  - normalizar CNPJ para 14 dígitos no banco;
  - impedir formato inválido e duplicidade no SQL;
  - não criar coluna cnpj paralela.

Observação:
  - validação dos dígitos verificadores continua no Backend (INVALID_CNPJ);
  - o SQL garante forma canônica (14 dígitos) + unicidade.
*/

SET XACT_ABORT ON;
BEGIN TRAN;

/* 1) Normalização segura de pontuação/espaços de CNPJ já armazenado. */
UPDATE a
SET
    tax_id = NULLIF(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(a.tax_id)), '.', ''), '/', ''), '-', ''), ' ', ''), CHAR(9), ''),
        ''
    ),
    updated_at = SYSUTCDATETIME()
FROM dbo.ads_advertiser AS a
WHERE a.tax_id IS NOT NULL
  AND a.tax_id <> NULLIF(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(a.tax_id)), '.', ''), '/', ''), '-', ''), ' ', ''), CHAR(9), ''),
        ''
      );

/* 2) Fail-fast: não mascarar identificador legado incompatível com CNPJ brasileiro. */
IF EXISTS (
    SELECT 1
    FROM dbo.ads_advertiser
    WHERE tax_id IS NOT NULL
      AND (
           LEN(tax_id) <> 14
        OR tax_id LIKE '%[^0-9]%'
      )
)
BEGIN
    SELECT advertiser_id, advertiser_code, advertiser_name, tax_id
    FROM dbo.ads_advertiser
    WHERE tax_id IS NOT NULL
      AND (
           LEN(tax_id) <> 14
        OR tax_id LIKE '%[^0-9]%'
      )
    ORDER BY advertiser_id;

    THROW 51001, 'Existem tax_id legados incompatíveis com CNPJ (14 dígitos). Corrija-os antes de reaplicar a migration.', 1;
END;

/* 3) Fail-fast para duplicidades após normalização. */
IF EXISTS (
    SELECT tax_id
    FROM dbo.ads_advertiser
    WHERE tax_id IS NOT NULL
    GROUP BY tax_id
    HAVING COUNT(*) > 1
)
BEGIN
    SELECT tax_id, COUNT(*) AS qty
    FROM dbo.ads_advertiser
    WHERE tax_id IS NOT NULL
    GROUP BY tax_id
    HAVING COUNT(*) > 1;

    THROW 51002, 'Existem CNPJs duplicados em dbo.ads_advertiser. Saneie antes de reaplicar a migration.', 1;
END;

/* 4) Constraint de forma canônica: NULL ou exatamente 14 dígitos. */
IF NOT EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.ads_advertiser')
      AND name = 'CK_ads_advertiser_tax_id_cnpj'
)
BEGIN
    ALTER TABLE dbo.ads_advertiser WITH CHECK
    ADD CONSTRAINT CK_ads_advertiser_tax_id_cnpj
        CHECK (
            tax_id IS NULL
            OR (LEN(tax_id) = 14 AND tax_id NOT LIKE '%[^0-9]%')
        );
END;

/* 5) Um CNPJ não nulo identifica no máximo um anunciante. */
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.ads_advertiser')
      AND name = 'UX_ads_advertiser_tax_id_cnpj'
)
BEGIN
    CREATE UNIQUE INDEX UX_ads_advertiser_tax_id_cnpj
        ON dbo.ads_advertiser(tax_id)
        WHERE tax_id IS NOT NULL;
END;

/* 6) Registry: documenta o acerto sem criar nova capability. */
UPDATE dbo.platform_capability_registry
SET
    current_state = 'dbo.ads_advertiser materializada com identidade comercial própria, lifecycle, row_version e CNPJ persistido canonicamente em tax_id (14 dígitos), com unicidade no SQL e validação matemática no Backend.',
    decision_reason = 'Advertiser Core continua sendo a fonte da verdade do anunciante. CNPJ usa tax_id existente; não foi criada coluna ou entidade fiscal paralela.',
    notes = CONCAT(
        COALESCE(NULLIF(notes, '' ) + ' ', ''),
        'Acerto CNPJ homologável: SQL garante formato canônico e unicidade; Backend valida dígitos verificadores; Frontend apresenta máscara 00.000.000/0000-00.'
    ),
    updated_at = SYSUTCDATETIME()
WHERE domain_code = 'HDUD_ADS'
  AND capability_code = 'ADVERTISER_CORE';

COMMIT;
GO

/* Evidência pós-migration */
SELECT
    advertiser_id,
    advertiser_code,
    advertiser_name,
    legal_name,
    tax_id,
    email,
    phone,
    status_code,
    updated_at
FROM dbo.ads_advertiser
ORDER BY advertiser_id;
GO

SELECT
    i.name AS index_name,
    i.is_unique,
    i.filter_definition
FROM sys.indexes AS i
WHERE i.object_id = OBJECT_ID('dbo.ads_advertiser')
  AND i.name = 'UX_ads_advertiser_tax_id_cnpj';
GO

SELECT
    cc.name AS constraint_name,
    cc.definition,
    cc.is_disabled,
    cc.is_not_trusted
FROM sys.check_constraints AS cc
WHERE cc.parent_object_id = OBJECT_ID('dbo.ads_advertiser')
  AND cc.name = 'CK_ads_advertiser_tax_id_cnpj';
GO
