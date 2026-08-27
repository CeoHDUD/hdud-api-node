USE [HDUD_CORE];
GO

/* ============================================================
   HDUD — Validação pós-deploy | Reserva econômica
   Apenas leitura. Não altera dados.
   Troque @user_id pelo usuário em homologação.
   ============================================================ */
DECLARE @user_id BIGINT = 1;
DECLARE @year INT = YEAR(GETUTCDATE());
DECLARE @month INT = MONTH(GETUTCDATE());

SELECT
    f.code AS feature_code,
    f.enforcement_mode,
    pf.int_value AS quota_value,
    ISNULL(u.consumed_value,0) AS consumed_value,
    ISNULL(u.reserved_value,0) AS reserved_value,
    pf.int_value - ISNULL(u.consumed_value,0) - ISNULL(u.reserved_value,0) AS remaining_value
FROM dbo.subscription_plan_feature pf
JOIN dbo.subscription_feature f ON f.feature_id = pf.feature_id
LEFT JOIN dbo.user_feature_usage_monthly u
  ON u.user_id = @user_id
 AND u.feature_id = f.feature_id
 AND u.reference_year = @year
 AND u.reference_month = @month
WHERE pf.plan_id = dbo.fn_GetEffectivePlanId(@user_id)
  AND f.code IN
  (
      'STORY_AI_GENERATION_COUNT',
      'CHAPTER_AI_GENERATION_COUNT',
      'AI_REGENERATION_COUNT'
  )
ORDER BY f.code;

SELECT TOP (100)
    e.enforcement_event_id,
    e.occurred_at,
    f.code AS feature_code,
    e.action_code,
    e.requested_value,
    e.consumed_before,
    e.consumed_after,
    e.quota_value,
    e.allowed,
    e.reason_code,
    e.entity_type,
    e.entity_id,
    JSON_VALUE(e.metadata_json,'$.reservation_event_id') AS reservation_event_id,
    JSON_VALUE(e.metadata_json,'$.reservation_scope') AS reservation_scope,
    JSON_VALUE(e.metadata_json,'$.source') AS source,
    JSON_VALUE(e.metadata_json,'$.economic_operation') AS economic_operation,
    e.metadata_json
FROM dbo.subscription_enforcement_event e
JOIN dbo.subscription_feature f ON f.feature_id = e.feature_id
WHERE e.user_id = @user_id
  AND e.occurred_at >= DATEFROMPARTS(@year,@month,1)
ORDER BY e.enforcement_event_id DESC;

SELECT TOP (100)
    ai_usage_id,
    occurred_at,
    operation_code,
    entity_type,
    entity_id,
    status,
    model,
    input_tokens,
    output_tokens,
    total_cost_usd
FROM dbo.ai_usage_ledger
WHERE user_id = @user_id
  AND occurred_at >= DATEFROMPARTS(@year,@month,1)
ORDER BY ai_usage_id DESC;
GO
