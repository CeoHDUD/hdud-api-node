// C:\HDUD_DATA\hdud-api-node\src\db\sqlConfig.js
// Centraliza a config do MSSQL via ENV (compatível Windows + Docker)

export const sqlConfig = (() => {
  const server =
    process.env.SQL_HOST ||
    process.env.SQL_SERVER ||
    process.env.DB_HOST ||
    "host.docker.internal";

  const port = Number(process.env.SQL_PORT || process.env.DB_PORT || 1433);

  const user =
    process.env.SQL_USER ||
    process.env.DB_USER ||
    "sa";

  const password =
    process.env.SQL_PASSWORD ||
    process.env.DB_PASSWORD ||
    "SenhaForte#2025";

  const database =
    process.env.SQL_DB ||
    process.env.SQL_DATABASE ||
    process.env.DB_NAME ||
    "HDUD_CORE";

  const encrypt = String(process.env.SQL_ENCRYPT || "false").toLowerCase() === "true";
  const trustServerCertificate = String(process.env.SQL_TRUST_CERT || "true").toLowerCase() === "true";

  return {
    user,
    password,
    server,
    port,
    database,
    options: {
      encrypt,
      trustServerCertificate,
    },
    pool: {
      max: Number(process.env.SQL_POOL_MAX || 10),
      min: Number(process.env.SQL_POOL_MIN || 0),
      idleTimeoutMillis: Number(process.env.SQL_POOL_IDLE || 30000),
    },
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT || 30000),
    connectionTimeout: Number(process.env.SQL_CONN_TIMEOUT || 15000),
  };
})();
