// C:\HDUD_DATA\hdud-api-node\src\db\pool.js
import sql from "mssql";

/**
 * Compat env (aceita vários nomes pra não quebrar setups antigos):
 * - Host: DB_SERVER | DB_HOST | SQLSERVER_HOST | MSSQL_HOST | HOST
 * - Port: DB_PORT | SQLSERVER_PORT | MSSQL_PORT
 * - User: DB_USER | DB_USERNAME | SQLSERVER_USER | MSSQL_USER | USER
 * - Pass: DB_PASSWORD | SQLSERVER_PASSWORD | MSSQL_PASSWORD | PASSWORD
 * - DB:   DB_NAME | SQLSERVER_DB | MSSQL_DB | DATABASE
 */

const env = (k) => (process.env[k] ?? "").toString().trim();
const envInt = (k, d) => {
  const v = parseInt(env(k), 10);
  return Number.isFinite(v) ? v : d;
};
const envBool = (k, d) => {
  const v = env(k).toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return d;
};

const server =
  env("DB_SERVER") ||
  env("DB_HOST") ||
  env("SQLSERVER_HOST") ||
  env("MSSQL_HOST") ||
  env("HOST") ||
  "host.docker.internal";

const port =
  envInt("DB_PORT", undefined) ??
  envInt("SQLSERVER_PORT", undefined) ??
  envInt("MSSQL_PORT", undefined) ??
  1433;

const user =
  env("DB_USER") ||
  env("DB_USERNAME") ||
  env("SQLSERVER_USER") ||
  env("MSSQL_USER") ||
  env("USER");

const password =
  env("DB_PASSWORD") ||
  env("SQLSERVER_PASSWORD") ||
  env("MSSQL_PASSWORD") ||
  env("PASSWORD");

const database =
  env("DB_NAME") ||
  env("SQLSERVER_DB") ||
  env("MSSQL_DB") ||
  env("DATABASE");

const encrypt = envBool("DB_ENCRYPT", false); // default false pra ambiente local
const trustServerCertificate = envBool("DB_TRUST_SERVER_CERT", true); // default true pra local

const poolConfig = {
  server,
  port,
  user,
  password,
  database,
  options: {
    encrypt,
    trustServerCertificate,
    enableArithAbort: true,
  },
  pool: {
    max: envInt("DB_POOL_MAX", 10),
    min: envInt("DB_POOL_MIN", 0),
    idleTimeoutMillis: envInt("DB_POOL_IDLE_MS", 30000),
  },
};

let _poolPromise = null;

export function getPoolPromise() {
  if (_poolPromise) return _poolPromise;

  const pool = new sql.ConnectionPool(poolConfig);
  _poolPromise = pool.connect().catch((err) => {
    // Se falhar na 1ª conexão, reseta pra permitir retry em restart
    _poolPromise = null;
    throw err;
  });

  return _poolPromise;
}

// Compat com o import atual do memories.js: { poolPromise }
export const poolPromise = getPoolPromise();

// útil pra quem precisar do driver
export { sql, poolConfig };
