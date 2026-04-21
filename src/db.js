// C:\HDUD_DATA\hdud-api-node\src\db.js

import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT, 10),
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: true
  }
};

let pool;

export async function getPool() {
  if (pool) return pool;

  try {
    pool = await sql.connect(config);
    console.log('[DB] Conectado ao SQL Server.');
    return pool;
  } catch (err) {
    console.error('[DB] Erro ao conectar:', err);
    throw err;
  }
}

// exporta o sql para usar tipos (Int, BigInt, NVarChar, etc.) nas rotas
export { sql };
