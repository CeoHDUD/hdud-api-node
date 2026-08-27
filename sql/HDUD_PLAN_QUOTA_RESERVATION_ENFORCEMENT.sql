USE [HDUD_CORE];
GO

/* ============================================================
   HDUD — Planos & Uso | Enforcement Econômico
   Reserva atômica de quota para operações pagas.

   Contrato:
     CHECK   -> observacional
     RESERVE -> atômico, antes da IA
     COMMIT  -> reserved - N / consumed + N
     RELEASE -> reserved - N / consumed inalterado

   O enforcement_event_id do RESERVE é o token da reserva.
   ============================================================ */

CREATE OR ALTER PROCEDURE dbo.p_ReservePlanQuota
    @user_id BIGINT,
    @feature_code VARCHAR(80),
    @reserve_value BIGINT = 1,
    @entity_type VARCHAR(40) = NULL,
    @entity_id BIGINT = NULL,
    @metadata_json NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @reserve_value IS NULL OR @reserve_value <= 0
        THROW 51100, 'reserve_value deve ser maior que zero.', 1;

    IF @feature_code IN ('STORY_AI_GENERATION_COUNT','CHAPTER_AI_GENERATION_COUNT')
        THROW 51101, 'Gerações narrativas devem usar dbo.p_ReserveNarrativeAiGenerationQuota.', 1;

    IF @feature_code = 'AUDIO_TRANSCRIPTION_SECONDS'
        THROW 51102, 'Áudio deve continuar usando o fluxo homologado de reserva/consumo.', 1;

    DECLARE
        @plan_id INT = dbo.fn_GetEffectivePlanId(@user_id),
        @feature_id INT,
        @mode VARCHAR(20),
        @quota BIGINT,
        @year INT = YEAR(GETUTCDATE()),
        @month INT = MONTH(GETUTCDATE()),
        @consumed BIGINT = 0,
        @reserved BIGINT = 0,
        @reservation_event_id BIGINT,
        @lock_result INT,
        @lock_resource NVARCHAR(255);

    SELECT
        @feature_id = f.feature_id,
        @mode = f.enforcement_mode,
        @quota = pf.int_value
    FROM dbo.subscription_feature f
    JOIN dbo.subscription_plan_feature pf
      ON pf.feature_id = f.feature_id
    WHERE f.code = @feature_code
      AND f.is_active = 1
      AND pf.plan_id = @plan_id
      AND pf.is_enabled = 1;

    IF @feature_id IS NULL
        THROW 51103, 'Feature não configurada para o plano.', 1;

    IF @mode <> 'QUOTA'
        THROW 51104, 'Feature informada não é uma quota.', 1;

    SET @lock_resource = CONCAT('HDUD:PLAN_QUOTA:', @user_id, ':', @feature_id, ':', @year, ':', @month);

    BEGIN TRANSACTION;

    EXEC @lock_result = sys.sp_getapplock
        @Resource = @lock_resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 10000;

    IF @lock_result < 0
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51105, 'Não foi possível obter lock da quota.', 1;
    END;

    IF NOT EXISTS
    (
        SELECT 1
        FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
        WHERE user_id = @user_id
          AND feature_id = @feature_id
          AND reference_year = @year
          AND reference_month = @month
    )
    BEGIN
        INSERT dbo.user_feature_usage_monthly
            (user_id, feature_id, reference_year, reference_month)
        VALUES
            (@user_id, @feature_id, @year, @month);
    END;

    SELECT
        @consumed = ISNULL(consumed_value,0),
        @reserved = ISNULL(reserved_value,0)
    FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
    WHERE user_id = @user_id
      AND feature_id = @feature_id
      AND reference_year = @year
      AND reference_month = @month;

    IF @consumed + @reserved + @reserve_value > ISNULL(@quota,0)
    BEGIN
        INSERT dbo.subscription_enforcement_event
        (
            user_id, plan_id, feature_id, action_code, requested_value,
            consumed_before, consumed_after, quota_value, allowed, reason_code,
            entity_type, entity_id, metadata_json
        )
        VALUES
        (
            @user_id, @plan_id, @feature_id, 'DENY', @reserve_value,
            @consumed, @consumed, @quota, 0, 'PLAN_MONTHLY_QUOTA_EXCEEDED',
            @entity_type, @entity_id, @metadata_json
        );

        COMMIT TRANSACTION;

        SELECT
            1 AS ok,
            0 AS allowed,
            'PLAN_MONTHLY_QUOTA_EXCEEDED' AS reason_code,
            @feature_code AS feature_code,
            @quota AS limit_or_quota_value,
            @consumed AS consumed_value,
            @reserved AS reserved_value,
            @quota - @consumed - @reserved AS remaining_value,
            CAST(NULL AS BIGINT) AS reservation_event_id;
        RETURN;
    END;

    UPDATE dbo.user_feature_usage_monthly
    SET
        reserved_value = reserved_value + @reserve_value,
        updated_at = SYSUTCDATETIME()
    WHERE user_id = @user_id
      AND feature_id = @feature_id
      AND reference_year = @year
      AND reference_month = @month;

    DECLARE @reserve_metadata NVARCHAR(MAX) =
        JSON_MODIFY(COALESCE(NULLIF(@metadata_json,''), N'{}'), '$.reservation_scope', 'FEATURE');

    INSERT dbo.subscription_enforcement_event
    (
        user_id, plan_id, feature_id, action_code, requested_value,
        consumed_before, consumed_after, quota_value, allowed, reason_code,
        entity_type, entity_id, metadata_json
    )
    VALUES
    (
        @user_id, @plan_id, @feature_id, 'RESERVE', @reserve_value,
        @consumed, @consumed, @quota, 1, NULL,
        @entity_type, @entity_id, @reserve_metadata
    );

    SET @reservation_event_id = SCOPE_IDENTITY();

    COMMIT TRANSACTION;

    SELECT
        1 AS ok,
        1 AS allowed,
        NULL AS reason_code,
        @feature_code AS feature_code,
        @quota AS limit_or_quota_value,
        @consumed AS consumed_value,
        @reserved + @reserve_value AS reserved_value,
        @quota - @consumed - @reserved - @reserve_value AS remaining_value,
        @reservation_event_id AS reservation_event_id;
END;
GO

CREATE OR ALTER PROCEDURE dbo.p_ReserveNarrativeAiGenerationQuota
    @user_id BIGINT,
    @target_feature_code VARCHAR(80),
    @reserve_value BIGINT = 1,
    @entity_type VARCHAR(40) = NULL,
    @entity_id BIGINT = NULL,
    @metadata_json NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @reserve_value IS NULL OR @reserve_value <= 0
        THROW 51200, 'reserve_value deve ser maior que zero.', 1;

    IF @target_feature_code NOT IN ('STORY_AI_GENERATION_COUNT','CHAPTER_AI_GENERATION_COUNT')
        THROW 51201, 'target_feature_code inválido para o pool narrativo.', 1;

    DECLARE
        @plan_id INT = dbo.fn_GetEffectivePlanId(@user_id),
        @story_feature_id INT,
        @chapter_feature_id INT,
        @target_feature_id INT,
        @story_quota BIGINT,
        @chapter_quota BIGINT,
        @quota BIGINT,
        @year INT = YEAR(GETUTCDATE()),
        @month INT = MONTH(GETUTCDATE()),
        @consumed BIGINT = 0,
        @reserved BIGINT = 0,
        @reservation_event_id BIGINT,
        @lock_result INT,
        @lock_resource NVARCHAR(255);

    SELECT
        @story_feature_id = f.feature_id,
        @story_quota = pf.int_value
    FROM dbo.subscription_feature f
    JOIN dbo.subscription_plan_feature pf ON pf.feature_id = f.feature_id
    WHERE f.code = 'STORY_AI_GENERATION_COUNT'
      AND f.is_active = 1
      AND f.enforcement_mode = 'QUOTA'
      AND pf.plan_id = @plan_id
      AND pf.is_enabled = 1;

    SELECT
        @chapter_feature_id = f.feature_id,
        @chapter_quota = pf.int_value
    FROM dbo.subscription_feature f
    JOIN dbo.subscription_plan_feature pf ON pf.feature_id = f.feature_id
    WHERE f.code = 'CHAPTER_AI_GENERATION_COUNT'
      AND f.is_active = 1
      AND f.enforcement_mode = 'QUOTA'
      AND pf.plan_id = @plan_id
      AND pf.is_enabled = 1;

    IF @story_feature_id IS NULL OR @chapter_feature_id IS NULL
        THROW 51202, 'Pool de Gerações Narrativas não configurado para o plano.', 1;

    SET @quota = CASE WHEN @story_quota <= @chapter_quota THEN @story_quota ELSE @chapter_quota END;
    SET @target_feature_id = CASE WHEN @target_feature_code = 'STORY_AI_GENERATION_COUNT'
                                  THEN @story_feature_id ELSE @chapter_feature_id END;

    SET @lock_resource = CONCAT('HDUD:NARRATIVE_AI:', @user_id, ':', @year, ':', @month);

    BEGIN TRANSACTION;

    EXEC @lock_result = sys.sp_getapplock
        @Resource = @lock_resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 10000;

    IF @lock_result < 0
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51203, 'Não foi possível obter lock do pool narrativo.', 1;
    END;

    IF NOT EXISTS
    (
        SELECT 1 FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
        WHERE user_id=@user_id AND feature_id=@story_feature_id
          AND reference_year=@year AND reference_month=@month
    )
        INSERT dbo.user_feature_usage_monthly(user_id,feature_id,reference_year,reference_month)
        VALUES(@user_id,@story_feature_id,@year,@month);

    IF NOT EXISTS
    (
        SELECT 1 FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
        WHERE user_id=@user_id AND feature_id=@chapter_feature_id
          AND reference_year=@year AND reference_month=@month
    )
        INSERT dbo.user_feature_usage_monthly(user_id,feature_id,reference_year,reference_month)
        VALUES(@user_id,@chapter_feature_id,@year,@month);

    SELECT
        @consumed = ISNULL(SUM(consumed_value),0),
        @reserved = ISNULL(SUM(reserved_value),0)
    FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
    WHERE user_id = @user_id
      AND feature_id IN (@story_feature_id,@chapter_feature_id)
      AND reference_year = @year
      AND reference_month = @month;

    IF @consumed + @reserved + @reserve_value > ISNULL(@quota,0)
    BEGIN
        INSERT dbo.subscription_enforcement_event
        (
            user_id,plan_id,feature_id,action_code,requested_value,
            consumed_before,consumed_after,quota_value,allowed,reason_code,
            entity_type,entity_id,metadata_json
        )
        VALUES
        (
            @user_id,@plan_id,@target_feature_id,'DENY',@reserve_value,
            @consumed,@consumed,@quota,0,'PLAN_MONTHLY_QUOTA_EXCEEDED',
            @entity_type,@entity_id,@metadata_json
        );

        COMMIT TRANSACTION;

        SELECT
            1 AS ok,
            0 AS allowed,
            'PLAN_MONTHLY_QUOTA_EXCEEDED' AS reason_code,
            'NARRATIVE_AI_GENERATION_COUNT' AS feature_code,
            @quota AS limit_or_quota_value,
            @consumed AS consumed_value,
            @reserved AS reserved_value,
            @quota - @consumed - @reserved AS remaining_value,
            CAST(NULL AS BIGINT) AS reservation_event_id;
        RETURN;
    END;

    UPDATE dbo.user_feature_usage_monthly
    SET reserved_value = reserved_value + @reserve_value,
        updated_at = SYSUTCDATETIME()
    WHERE user_id = @user_id
      AND feature_id = @target_feature_id
      AND reference_year = @year
      AND reference_month = @month;

    DECLARE @reserve_metadata NVARCHAR(MAX) =
        JSON_MODIFY(COALESCE(NULLIF(@metadata_json,''), N'{}'), '$.reservation_scope', 'NARRATIVE_AI');
    SET @reserve_metadata = JSON_MODIFY(@reserve_metadata, '$.target_feature_code', @target_feature_code);

    INSERT dbo.subscription_enforcement_event
    (
        user_id,plan_id,feature_id,action_code,requested_value,
        consumed_before,consumed_after,quota_value,allowed,reason_code,
        entity_type,entity_id,metadata_json
    )
    VALUES
    (
        @user_id,@plan_id,@target_feature_id,'RESERVE',@reserve_value,
        @consumed,@consumed,@quota,1,NULL,
        @entity_type,@entity_id,@reserve_metadata
    );

    SET @reservation_event_id = SCOPE_IDENTITY();

    COMMIT TRANSACTION;

    SELECT
        1 AS ok,
        1 AS allowed,
        NULL AS reason_code,
        'NARRATIVE_AI_GENERATION_COUNT' AS feature_code,
        @quota AS limit_or_quota_value,
        @consumed AS consumed_value,
        @reserved + @reserve_value AS reserved_value,
        @quota - @consumed - @reserved - @reserve_value AS remaining_value,
        @reservation_event_id AS reservation_event_id;
END;
GO

CREATE OR ALTER PROCEDURE dbo.p_CommitPlanQuotaReservation
    @user_id BIGINT,
    @reservation_event_id BIGINT,
    @ai_usage_id BIGINT = NULL,
    @metadata_json NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @plan_id INT,
        @feature_id INT,
        @feature_code VARCHAR(80),
        @reserve_value BIGINT,
        @entity_type VARCHAR(40),
        @entity_id BIGINT,
        @reserve_metadata NVARCHAR(MAX),
        @occurred_at DATETIME2(3),
        @year INT,
        @month INT,
        @scope VARCHAR(30),
        @quota BIGINT,
        @consumed BIGINT = 0,
        @reserved BIGINT = 0,
        @existing_action VARCHAR(30),
        @lock_result INT,
        @lock_resource NVARCHAR(255),
        @child_metadata NVARCHAR(MAX);

    SELECT
        @plan_id = e.plan_id,
        @feature_id = e.feature_id,
        @feature_code = f.code,
        @reserve_value = e.requested_value,
        @entity_type = e.entity_type,
        @entity_id = e.entity_id,
        @reserve_metadata = e.metadata_json,
        @occurred_at = e.occurred_at,
        @quota = e.quota_value,
        @scope = JSON_VALUE(e.metadata_json,'$.reservation_scope')
    FROM dbo.subscription_enforcement_event e
    JOIN dbo.subscription_feature f ON f.feature_id = e.feature_id
    WHERE e.enforcement_event_id = @reservation_event_id
      AND e.user_id = @user_id
      AND e.action_code = 'RESERVE'
      AND e.allowed = 1;

    IF @feature_id IS NULL
        THROW 51300, 'Reserva de quota não encontrada.', 1;

    SET @year = YEAR(@occurred_at);
    SET @month = MONTH(@occurred_at);
    SET @lock_resource = CASE WHEN @scope = 'NARRATIVE_AI'
        THEN CONCAT('HDUD:NARRATIVE_AI:', @user_id, ':', @year, ':', @month)
        ELSE CONCAT('HDUD:PLAN_QUOTA:', @user_id, ':', @feature_id, ':', @year, ':', @month)
    END;

    BEGIN TRANSACTION;

    EXEC @lock_result = sys.sp_getapplock
        @Resource = @lock_resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 10000;

    IF @lock_result < 0
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51301, 'Não foi possível obter lock da reserva.', 1;
    END;

    SELECT TOP (1) @existing_action = action_code
    FROM dbo.subscription_enforcement_event WITH (UPDLOCK,HOLDLOCK)
    WHERE user_id = @user_id
      AND action_code IN ('CONSUME','RELEASE')
      AND JSON_VALUE(metadata_json,'$.reservation_event_id') = CONVERT(VARCHAR(30),@reservation_event_id)
    ORDER BY enforcement_event_id DESC;

    IF @existing_action = 'CONSUME'
    BEGIN
        COMMIT TRANSACTION;
        SELECT 1 AS ok, 1 AS allowed, 'ALREADY_COMMITTED' AS reason_code, @reservation_event_id AS reservation_event_id;
        RETURN;
    END;

    IF @existing_action = 'RELEASE'
    BEGIN
        COMMIT TRANSACTION;
        SELECT 1 AS ok, 0 AS allowed, 'RESERVATION_ALREADY_RELEASED' AS reason_code, @reservation_event_id AS reservation_event_id;
        RETURN;
    END;

    SELECT
        @consumed = ISNULL(consumed_value,0),
        @reserved = ISNULL(reserved_value,0)
    FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
    WHERE user_id=@user_id
      AND feature_id=@feature_id
      AND reference_year=@year
      AND reference_month=@month;

    IF @reserved < @reserve_value
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51302, 'Reserva agregada inconsistente.', 1;
    END;

    UPDATE dbo.user_feature_usage_monthly
    SET
        reserved_value = reserved_value - @reserve_value,
        consumed_value = consumed_value + @reserve_value,
        last_consumed_at = SYSUTCDATETIME(),
        updated_at = SYSUTCDATETIME()
    WHERE user_id=@user_id
      AND feature_id=@feature_id
      AND reference_year=@year
      AND reference_month=@month;

    SET @child_metadata = COALESCE(NULLIF(@metadata_json,''), @reserve_metadata, N'{}');
    SET @child_metadata = JSON_MODIFY(@child_metadata,'$.reservation_event_id',@reservation_event_id);
    SET @child_metadata = JSON_MODIFY(@child_metadata,'$.reservation_scope',COALESCE(@scope,'FEATURE'));

    INSERT dbo.subscription_enforcement_event
    (
        user_id,plan_id,feature_id,action_code,requested_value,
        consumed_before,consumed_after,quota_value,allowed,reason_code,
        entity_type,entity_id,ai_usage_id,metadata_json
    )
    VALUES
    (
        @user_id,@plan_id,@feature_id,'CONSUME',@reserve_value,
        @consumed,@consumed+@reserve_value,@quota,1,NULL,
        @entity_type,@entity_id,@ai_usage_id,@child_metadata
    );

    COMMIT TRANSACTION;

    SELECT 1 AS ok, 1 AS allowed, NULL AS reason_code,
           @reservation_event_id AS reservation_event_id;
END;
GO

CREATE OR ALTER PROCEDURE dbo.p_ReleasePlanQuotaReservation
    @user_id BIGINT,
    @reservation_event_id BIGINT,
    @reason_code VARCHAR(80) = NULL,
    @metadata_json NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @plan_id INT,
        @feature_id INT,
        @feature_code VARCHAR(80),
        @reserve_value BIGINT,
        @entity_type VARCHAR(40),
        @entity_id BIGINT,
        @reserve_metadata NVARCHAR(MAX),
        @occurred_at DATETIME2(3),
        @year INT,
        @month INT,
        @scope VARCHAR(30),
        @quota BIGINT,
        @consumed BIGINT = 0,
        @reserved BIGINT = 0,
        @existing_action VARCHAR(30),
        @lock_result INT,
        @lock_resource NVARCHAR(255),
        @child_metadata NVARCHAR(MAX);

    SELECT
        @plan_id = e.plan_id,
        @feature_id = e.feature_id,
        @feature_code = f.code,
        @reserve_value = e.requested_value,
        @entity_type = e.entity_type,
        @entity_id = e.entity_id,
        @reserve_metadata = e.metadata_json,
        @occurred_at = e.occurred_at,
        @quota = e.quota_value,
        @scope = JSON_VALUE(e.metadata_json,'$.reservation_scope')
    FROM dbo.subscription_enforcement_event e
    JOIN dbo.subscription_feature f ON f.feature_id = e.feature_id
    WHERE e.enforcement_event_id = @reservation_event_id
      AND e.user_id = @user_id
      AND e.action_code = 'RESERVE'
      AND e.allowed = 1;

    IF @feature_id IS NULL
        THROW 51400, 'Reserva de quota não encontrada.', 1;

    SET @year = YEAR(@occurred_at);
    SET @month = MONTH(@occurred_at);
    SET @lock_resource = CASE WHEN @scope = 'NARRATIVE_AI'
        THEN CONCAT('HDUD:NARRATIVE_AI:', @user_id, ':', @year, ':', @month)
        ELSE CONCAT('HDUD:PLAN_QUOTA:', @user_id, ':', @feature_id, ':', @year, ':', @month)
    END;

    BEGIN TRANSACTION;

    EXEC @lock_result = sys.sp_getapplock
        @Resource = @lock_resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 10000;

    IF @lock_result < 0
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51401, 'Não foi possível obter lock da reserva.', 1;
    END;

    SELECT TOP (1) @existing_action = action_code
    FROM dbo.subscription_enforcement_event WITH (UPDLOCK,HOLDLOCK)
    WHERE user_id = @user_id
      AND action_code IN ('CONSUME','RELEASE')
      AND JSON_VALUE(metadata_json,'$.reservation_event_id') = CONVERT(VARCHAR(30),@reservation_event_id)
    ORDER BY enforcement_event_id DESC;

    IF @existing_action = 'RELEASE'
    BEGIN
        COMMIT TRANSACTION;
        SELECT 1 AS ok, 1 AS allowed, 'ALREADY_RELEASED' AS reason_code, @reservation_event_id AS reservation_event_id;
        RETURN;
    END;

    IF @existing_action = 'CONSUME'
    BEGIN
        COMMIT TRANSACTION;
        SELECT 1 AS ok, 0 AS allowed, 'RESERVATION_ALREADY_COMMITTED' AS reason_code, @reservation_event_id AS reservation_event_id;
        RETURN;
    END;

    SELECT
        @consumed = ISNULL(consumed_value,0),
        @reserved = ISNULL(reserved_value,0)
    FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
    WHERE user_id=@user_id
      AND feature_id=@feature_id
      AND reference_year=@year
      AND reference_month=@month;

    IF @reserved < @reserve_value
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51402, 'Reserva agregada inconsistente.', 1;
    END;

    UPDATE dbo.user_feature_usage_monthly
    SET
        reserved_value = reserved_value - @reserve_value,
        updated_at = SYSUTCDATETIME()
    WHERE user_id=@user_id
      AND feature_id=@feature_id
      AND reference_year=@year
      AND reference_month=@month;

    SET @child_metadata = COALESCE(NULLIF(@metadata_json,''), @reserve_metadata, N'{}');
    SET @child_metadata = JSON_MODIFY(@child_metadata,'$.reservation_event_id',@reservation_event_id);
    SET @child_metadata = JSON_MODIFY(@child_metadata,'$.reservation_scope',COALESCE(@scope,'FEATURE'));

    INSERT dbo.subscription_enforcement_event
    (
        user_id,plan_id,feature_id,action_code,requested_value,
        consumed_before,consumed_after,quota_value,allowed,reason_code,
        entity_type,entity_id,metadata_json
    )
    VALUES
    (
        @user_id,@plan_id,@feature_id,'RELEASE',@reserve_value,
        @consumed,@consumed,@quota,1,COALESCE(@reason_code,'OPERATION_FAILED'),
        @entity_type,@entity_id,@child_metadata
    );

    COMMIT TRANSACTION;

    SELECT 1 AS ok, 1 AS allowed, COALESCE(@reason_code,'OPERATION_FAILED') AS reason_code,
           @reservation_event_id AS reservation_event_id;
END;
GO

/* ============================================================
   Reforço do consumidor legado:
   - considera reserved_value;
   - serializa por applock;
   - pool História + Capítulo continua compartilhado.
   ============================================================ */
CREATE OR ALTER PROCEDURE dbo.p_ConsumePlanQuota
    @user_id BIGINT,
    @feature_code VARCHAR(80),
    @consume_value BIGINT = 1,
    @entity_type VARCHAR(40) = NULL,
    @entity_id BIGINT = NULL,
    @ai_usage_id BIGINT = NULL,
    @metadata_json NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @consume_value IS NULL OR @consume_value <= 0
        THROW 51000, 'consume_value deve ser maior que zero.', 1;

    DECLARE
        @plan_id INT = dbo.fn_GetEffectivePlanId(@user_id),
        @feature_id INT,
        @quota BIGINT,
        @mode VARCHAR(20),
        @year INT = YEAR(GETUTCDATE()),
        @month INT = MONTH(GETUTCDATE()),
        @consumed BIGINT = 0,
        @reserved BIGINT = 0,
        @lock_result INT,
        @lock_resource NVARCHAR(255),
        @story_feature_id INT,
        @chapter_feature_id INT,
        @story_quota BIGINT,
        @chapter_quota BIGINT;

    SELECT
        @feature_id = f.feature_id,
        @mode = f.enforcement_mode,
        @quota = pf.int_value
    FROM dbo.subscription_feature f
    JOIN dbo.subscription_plan_feature pf ON pf.feature_id = f.feature_id
    WHERE f.code = @feature_code
      AND f.is_active = 1
      AND pf.plan_id = @plan_id
      AND pf.is_enabled = 1;

    IF @feature_id IS NULL
        THROW 51001, 'Feature não configurada para o plano.', 1;

    IF @mode <> 'QUOTA'
        THROW 51002, 'Feature informada não é uma quota.', 1;

    IF @feature_code = 'AUDIO_TRANSCRIPTION_SECONDS'
        THROW 51003, 'Áudio deve continuar usando o fluxo homologado de reserva/consumo.', 1;

    IF @feature_code IN ('STORY_AI_GENERATION_COUNT','CHAPTER_AI_GENERATION_COUNT')
    BEGIN
        SELECT @story_feature_id=f.feature_id, @story_quota=pf.int_value
        FROM dbo.subscription_feature f
        JOIN dbo.subscription_plan_feature pf ON pf.feature_id=f.feature_id
        WHERE f.code='STORY_AI_GENERATION_COUNT' AND f.is_active=1
          AND pf.plan_id=@plan_id AND pf.is_enabled=1;

        SELECT @chapter_feature_id=f.feature_id, @chapter_quota=pf.int_value
        FROM dbo.subscription_feature f
        JOIN dbo.subscription_plan_feature pf ON pf.feature_id=f.feature_id
        WHERE f.code='CHAPTER_AI_GENERATION_COUNT' AND f.is_active=1
          AND pf.plan_id=@plan_id AND pf.is_enabled=1;

        IF @story_feature_id IS NULL OR @chapter_feature_id IS NULL
            THROW 51004, 'Pool de Gerações Narrativas não configurado.', 1;

        SET @quota = CASE WHEN @story_quota <= @chapter_quota THEN @story_quota ELSE @chapter_quota END;
        SET @lock_resource = CONCAT('HDUD:NARRATIVE_AI:',@user_id,':',@year,':',@month);
    END
    ELSE
        SET @lock_resource = CONCAT('HDUD:PLAN_QUOTA:',@user_id,':',@feature_id,':',@year,':',@month);

    BEGIN TRANSACTION;

    EXEC @lock_result = sys.sp_getapplock
        @Resource=@lock_resource,
        @LockMode='Exclusive',
        @LockOwner='Transaction',
        @LockTimeout=10000;

    IF @lock_result < 0
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51005, 'Não foi possível obter lock da quota.', 1;
    END;

    IF @feature_code IN ('STORY_AI_GENERATION_COUNT','CHAPTER_AI_GENERATION_COUNT')
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
                       WHERE user_id=@user_id AND feature_id=@story_feature_id AND reference_year=@year AND reference_month=@month)
            INSERT dbo.user_feature_usage_monthly(user_id,feature_id,reference_year,reference_month)
            VALUES(@user_id,@story_feature_id,@year,@month);

        IF NOT EXISTS (SELECT 1 FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
                       WHERE user_id=@user_id AND feature_id=@chapter_feature_id AND reference_year=@year AND reference_month=@month)
            INSERT dbo.user_feature_usage_monthly(user_id,feature_id,reference_year,reference_month)
            VALUES(@user_id,@chapter_feature_id,@year,@month);

        SELECT @consumed=ISNULL(SUM(consumed_value),0), @reserved=ISNULL(SUM(reserved_value),0)
        FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
        WHERE user_id=@user_id
          AND feature_id IN (@story_feature_id,@chapter_feature_id)
          AND reference_year=@year
          AND reference_month=@month;
    END
    ELSE
    BEGIN
        IF NOT EXISTS
        (
            SELECT 1 FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
            WHERE user_id=@user_id AND feature_id=@feature_id
              AND reference_year=@year AND reference_month=@month
        )
            INSERT dbo.user_feature_usage_monthly(user_id,feature_id,reference_year,reference_month)
            VALUES(@user_id,@feature_id,@year,@month);

        SELECT @consumed=ISNULL(consumed_value,0), @reserved=ISNULL(reserved_value,0)
        FROM dbo.user_feature_usage_monthly WITH (UPDLOCK,HOLDLOCK)
        WHERE user_id=@user_id AND feature_id=@feature_id
          AND reference_year=@year AND reference_month=@month;
    END;

    IF @consumed + @reserved + @consume_value > @quota
    BEGIN
        INSERT dbo.subscription_enforcement_event
        (
            user_id,plan_id,feature_id,action_code,requested_value,
            consumed_before,consumed_after,quota_value,allowed,reason_code,
            entity_type,entity_id,ai_usage_id,metadata_json
        )
        VALUES
        (
            @user_id,@plan_id,@feature_id,'DENY',@consume_value,
            @consumed,@consumed,@quota,0,'PLAN_MONTHLY_QUOTA_EXCEEDED',
            @entity_type,@entity_id,@ai_usage_id,@metadata_json
        );

        COMMIT TRANSACTION;
        SELECT 0 AS ok,0 AS allowed,'PLAN_MONTHLY_QUOTA_EXCEEDED' AS reason_code,
               @quota-@consumed-@reserved AS remaining_value;
        RETURN;
    END;

    UPDATE dbo.user_feature_usage_monthly
    SET consumed_value=consumed_value+@consume_value,
        last_consumed_at=SYSUTCDATETIME(),
        updated_at=SYSUTCDATETIME()
    WHERE user_id=@user_id AND feature_id=@feature_id
      AND reference_year=@year AND reference_month=@month;

    INSERT dbo.subscription_enforcement_event
    (
        user_id,plan_id,feature_id,action_code,requested_value,
        consumed_before,consumed_after,quota_value,allowed,
        entity_type,entity_id,ai_usage_id,metadata_json
    )
    VALUES
    (
        @user_id,@plan_id,@feature_id,'CONSUME',@consume_value,
        @consumed,@consumed+@consume_value,@quota,1,
        @entity_type,@entity_id,@ai_usage_id,@metadata_json
    );

    COMMIT TRANSACTION;

    SELECT 1 AS ok,1 AS allowed,
           @quota-(@consumed+@reserved+@consume_value) AS remaining_value;
END;
GO
