USE HDUD_CORE;
GO
SET XACT_ABORT ON;
GO

/*
  HDUD — Torre de Controle | Pendência 01B — Área / Setor do Operador
  Perfil organizacional administrativo, separado de identity_user e do RBAC.
  Não cria autoridade: department_name é apenas metadado organizacional.
*/

BEGIN TRAN;

IF OBJECT_ID(N'dbo.admin_operator_profile', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_operator_profile
    (
        user_id             int            NOT NULL,
        department_name     nvarchar(120)  NOT NULL,
        created_at          datetime2(3)   NOT NULL CONSTRAINT DF_admin_operator_profile_created_at DEFAULT SYSUTCDATETIME(),
        updated_at          datetime2(3)   NOT NULL CONSTRAINT DF_admin_operator_profile_updated_at DEFAULT SYSUTCDATETIME(),
        updated_by_user_id  int            NULL,

        CONSTRAINT PK_admin_operator_profile PRIMARY KEY (user_id),
        CONSTRAINT FK_admin_operator_profile_user
            FOREIGN KEY (user_id) REFERENCES dbo.identity_user(user_id),
        CONSTRAINT FK_admin_operator_profile_updated_by_user
            FOREIGN KEY (updated_by_user_id) REFERENCES dbo.identity_user(user_id),
        CONSTRAINT CK_admin_operator_profile_department_not_blank
            CHECK (LEN(LTRIM(RTRIM(department_name))) > 0)
    );
END;

COMMIT;
GO

SELECT
    p.user_id,
    u.email,
    p.department_name,
    p.created_at,
    p.updated_at,
    p.updated_by_user_id
FROM dbo.admin_operator_profile p
JOIN dbo.identity_user u ON u.user_id = p.user_id
ORDER BY p.department_name, u.full_name, u.email;
GO
