// C:\HDUD_DATA\hdud-api-node\src\db.js

import sql from "mssql";
import dotenv from "dotenv";
import { sqlConfig } from "./db/sqlConfig.js";

dotenv.config();

let pool = null;
let poolPromise = null;

export async function getPool() {
  if (pool?.connected) return pool;
  if (poolPromise) return poolPromise;

  poolPromise = sql
    .connect(sqlConfig)
    .then((connectedPool) => {
      pool = connectedPool;
      console.log("[DB] Conectado ao SQL Server.");
      return pool;
    })
    .catch((err) => {
      pool = null;
      poolPromise = null;
      console.error("[DB] Erro ao conectar:", err);
      throw err;
    });

  return poolPromise;
}

export async function closePool() {
  if (!pool) return;

  try {
    await pool.close();
  } finally {
    pool = null;
    poolPromise = null;
  }
}

export { sql };