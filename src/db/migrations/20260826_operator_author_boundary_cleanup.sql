USE HDUD_CORE;
GO
SET XACT_ABORT ON;
GO

/*
  HDUD — Torre de Controle | Pendência 01B
  Saneamento da fronteira AUTHOR x OPERATOR.

  Regra congelada:
  - identidades @hdud.ai pertencem exclusivamente ao contexto OPERATOR;
  - operador não possui identity_author;
  - o login AUTHOR nunca pode criar author para um operador corporativo.

  Este saneamento corrige especificamente o operador-modelo criado durante a homologação.
  É idempotente e aborta caso o author contaminado possua qualquer dependência real.
*/

DECLARE @OperatorEmail nvarchar(255) = N'op.marketing@hdud.ai';
DECLARE @UserId int;
DECLARE @AuthorId bigint;

SELECT
    @UserId = u.user_id,
    @AuthorId = u.author_id
FROM dbo.identity_user u
WHERE LOWER(u.email) = LOWER(@OperatorEmail);

IF @UserId IS NULL
    THROW 51000, 'Operador op.marketing@hdud.ai não encontrado.', 1;

BEGIN TRAN;

/* 1. Sessões AUTHOR deste operador são inválidas por definição e podem ser removidas. */
DELETE FROM dbo.identity_session
WHERE user_id = @UserId
  AND UPPER(ISNULL(session_context, '')) = 'AUTHOR';

/* 2. Se não houve contaminação de author, apenas garantir o contrato e finalizar. */
IF @AuthorId IS NOT NULL
BEGIN
    /* Desvincula primeiro; se qualquer validação abaixo falhar, XACT_ABORT/ROLLBACK restaura tudo. */
    UPDATE dbo.identity_user
    SET author_id = NULL
    WHERE user_id = @UserId
      AND author_id = @AuthorId;

    /*
      Verifica TODAS as FKs físicas que ainda referenciam identity_author.
      Não presume quais domínios existem hoje. Se houver qualquer referência real,
      o script aborta em vez de apagar conteúdo narrativo.
    */
    CREATE TABLE #AuthorRefs
    (
        reference_name nvarchar(512) NOT NULL,
        ref_count bigint NOT NULL
    );

    DECLARE
        @SchemaName sysname,
        @TableName sysname,
        @ColumnName sysname,
        @Sql nvarchar(max);

    DECLARE author_fk_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT
        OBJECT_SCHEMA_NAME(fk.parent_object_id),
        OBJECT_NAME(fk.parent_object_id),
        pc.name
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc
      ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns pc
      ON pc.object_id = fkc.parent_object_id
     AND pc.column_id = fkc.parent_column_id
    WHERE fk.referenced_object_id = OBJECT_ID(N'dbo.identity_author');

    OPEN author_fk_cursor;
    FETCH NEXT FROM author_fk_cursor INTO @SchemaName, @TableName, @ColumnName;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        SET @Sql = N'
            INSERT INTO #AuthorRefs(reference_name, ref_count)
            SELECT
                @ReferenceName,
                COUNT_BIG(*)
            FROM ' + QUOTENAME(@SchemaName) + N'.' + QUOTENAME(@TableName) + N'
            WHERE ' + QUOTENAME(@ColumnName) + N' = @AuthorId;';

        EXEC sys.sp_executesql
            @Sql,
            N'@ReferenceName nvarchar(512), @AuthorId bigint',
            @ReferenceName = @SchemaName + N'.' + @TableName + N'.' + @ColumnName,
            @AuthorId = @AuthorId;

        FETCH NEXT FROM author_fk_cursor INTO @SchemaName, @TableName, @ColumnName;
    END

    CLOSE author_fk_cursor;
    DEALLOCATE author_fk_cursor;

    IF EXISTS (SELECT 1 FROM #AuthorRefs WHERE ref_count > 0)
    BEGIN
        SELECT reference_name, ref_count
        FROM #AuthorRefs
        WHERE ref_count > 0
        ORDER BY reference_name;

        THROW 51001, 'Author contaminado possui referências reais. Abortando saneamento para preservar conteúdo.', 1;
    END

    DROP TABLE #AuthorRefs;

    /* Remove somente o author vazio criado pelo defeito. */
    DELETE FROM dbo.identity_author
    WHERE author_id = @AuthorId;

    IF @@ROWCOUNT <> 1
        THROW 51002, 'Author contaminado não foi encontrado para exclusão.', 1;
END

/* 3. Contrato final do operador. */
IF EXISTS
(
    SELECT 1
    FROM dbo.identity_user
    WHERE user_id = @UserId
      AND author_id IS NOT NULL
)
    THROW 51003, 'Operador permaneceu com author_id após saneamento.', 1;

COMMIT;
GO

/* Evidências */
SELECT
    u.user_id,
    u.email,
    u.full_name,
    u.author_id,
    u.is_active
FROM dbo.identity_user u
WHERE LOWER(u.email) = LOWER(N'op.marketing@hdud.ai');

SELECT
    r.role_code,
    ur.granted_at,
    ur.revoked_at
FROM dbo.admin_user_role ur
JOIN dbo.admin_role r
  ON r.role_id = ur.role_id
JOIN dbo.identity_user u
  ON u.user_id = ur.user_id
WHERE LOWER(u.email) = LOWER(N'op.marketing@hdud.ai')
ORDER BY r.role_code, ur.granted_at;

SELECT
    session_id,
    user_id,
    author_id,
    session_context,
    is_revoked,
    expires_at
FROM dbo.identity_session
WHERE user_id = (SELECT user_id FROM dbo.identity_user WHERE LOWER(email) = LOWER(N'op.marketing@hdud.ai'))
ORDER BY session_id DESC;
GO
