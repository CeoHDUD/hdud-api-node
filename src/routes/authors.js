// authors.js — HDUD API v0.5

import { Router } from 'express';
import { getPool, sql } from '../db.js';
import { getAuditContext } from '../utils/audit.js';

const router = Router();

/**
 * GET /authors
 * Lista todos os autores cadastrados.
 * (Montado como GET /authors porque o server usa: app.use('/authors', authorsRouter))
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query(`
        SELECT
          author_id,
          author_code,
          full_name,
          created_at
        FROM dbo.identity_author
        ORDER BY created_at DESC, author_id DESC;
      `);

    res.json(result.recordset);
  } catch (err) {
    console.error('[GET /authors] Erro SQL:', err);
    res.status(500).json({ error: 'Erro ao listar autores.' });
  }
});

/**
 * GET /authors/:id
 * Retorna os dados de um autor específico.
 */
router.get('/:id', async (req, res) => {
  const authorId = parseInt(req.params.id, 10);

  if (Number.isNaN(authorId)) {
    return res.status(400).json({ error: 'authorId inválido.' });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('author_id', sql.Int, authorId)
      .query(`
        SELECT
          author_id,
          author_code,
          full_name,
          created_at
        FROM dbo.identity_author
        WHERE author_id = @author_id;
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Autor não encontrado.' });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error('[GET /authors/:id] Erro SQL:', err);
    res.status(500).json({ error: 'Erro ao obter autor.' });
  }
});

/**
 * POST /authors
 * Cria um novo autor.
 * Body:
 * {
 *   "author_code": "ALE-0001",
 *   "full_name": "Alexandre Neves"
 * }
 */
router.post('/', async (req, res) => {
  const { author_code, full_name } = req.body;

  if (!author_code || !full_name) {
    return res.status(400).json({
      error: 'Campos obrigatórios: author_code, full_name.'
    });
  }

  try {
    const pool = await getPool();

    // 0) Contexto de auditoria (SYSTEM / USER / AUTHOR)
    const audit = getAuditContext(req);

    // 1) Verifica se já existe autor com o mesmo código
    const existsResult = await pool.request()
      .input('author_code', sql.VarChar(50), author_code)
      .query(`
        SELECT TOP 1 author_id
        FROM dbo.identity_author
        WHERE author_code = @author_code;
      `);

    if (existsResult.recordset.length > 0) {
      return res.status(409).json({
        error: 'Já existe um autor com este author_code.'
      });
    }

    // 2) Insere o autor
    const insertResult = await pool.request()
      .input('author_code', sql.VarChar(50), author_code)
      .input('full_name', sql.NVarChar(200), full_name)
      .query(`
        INSERT INTO dbo.identity_author (author_code, full_name)
        OUTPUT INSERTED.author_id,
               INSERTED.author_code,
               INSERTED.full_name,
               INSERTED.created_at
        VALUES (@author_code, @full_name);
      `);

    const author = insertResult.recordset[0];

    // 3) Registra AUTHOR_CREATED no ledger
    const payload = {
      author_id: author.author_id,
      author_code: author.author_code,
      full_name: author.full_name,
      created_at: author.created_at
    };

    try {
      await pool.request()
        .input('event_type', sql.VarChar(50), 'AUTHOR_CREATED')
        .input('entity_type', sql.VarChar(50), 'AUTHOR')
        .input('entity_id', sql.BigInt, author.author_id)
        .input('version_number', sql.Int, 1)
        .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .input('created_by', sql.VarChar(100), audit.created_by)
        .input('created_by_user_id', sql.BigInt, audit.created_by_user_id)
        .input('created_by_author_id', sql.BigInt, audit.created_by_author_id)
        .execute('dbo.p_RegisterIdentityEvent');
    } catch (ledgerErr) {
      console.error('[LEDGER] Erro ao registrar AUTHOR_CREATED:', ledgerErr);
      // não falha a criação do autor se só o ledger deu erro
    }

    res.status(201).json(author);
  } catch (err) {
    console.error('[POST /authors] Erro SQL:', err);
    res.status(500).json({ error: 'Erro ao criar autor.' });
  }
});

/**
 * PUT /authors/:id
 * Atualiza dados básicos do autor (hoje, apenas full_name).
 * Body:
 * {
 *   "full_name": "Novo nome"
 * }
 */
router.put('/:id', async (req, res) => {
  const authorId = parseInt(req.params.id, 10);
  const { full_name } = req.body;

  if (Number.isNaN(authorId)) {
    return res.status(400).json({ error: 'authorId inválido.' });
  }

  if (!full_name) {
    return res.status(400).json({
      error: 'Campo obrigatório: full_name.'
    });
  }

  try {
    const pool = await getPool();

    // 0) Contexto de auditoria
    const audit = getAuditContext(req);

    // 1) Busca o autor atual
    const currentResult = await pool.request()
      .input('author_id', sql.Int, authorId)
      .query(`
        SELECT
          author_id,
          author_code,
          full_name,
          created_at
        FROM dbo.identity_author
        WHERE author_id = @author_id;
      `);

    if (currentResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Autor não encontrado.' });
    }

    const current = currentResult.recordset[0];

    // Se o nome não mudou, pode só retornar o atual
    if (current.full_name === full_name) {
      return res.json(current);
    }

    // 2) Atualiza o autor
    const updateResult = await pool.request()
      .input('author_id', sql.Int, authorId)
      .input('full_name', sql.NVarChar(200), full_name)
      .query(`
        UPDATE dbo.identity_author
        SET full_name = @full_name
        OUTPUT INSERTED.author_id,
               INSERTED.author_code,
               INSERTED.full_name,
               INSERTED.created_at
        WHERE author_id = @author_id;
      `);

    const updated = updateResult.recordset[0];

    // 3) Calcula próximo version_number no ledger para este autor
    const versionResult = await pool.request()
      .input('entity_type', sql.VarChar(50), 'AUTHOR')
      .input('entity_id', sql.BigInt, authorId)
      .query(`
        SELECT ISNULL(MAX(version_number), 1) AS last_version
        FROM dbo.identity_ledger
        WHERE entity_type = @entity_type
          AND entity_id   = @entity_id;
      `);

    const lastVersion = versionResult.recordset[0]?.last_version || 1;
    const nextVersion = lastVersion + 1;

    // 4) Registra AUTHOR_UPDATED no ledger
    const payload = {
      before: current,
      after: updated
    };

    try {
      await pool.request()
        .input('event_type', sql.VarChar(50), 'AUTHOR_UPDATED')
        .input('entity_type', sql.VarChar(50), 'AUTHOR')
        .input('entity_id', sql.BigInt, authorId)
        .input('version_number', sql.Int, nextVersion)
        .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .input('created_by', sql.VarChar(100), audit.created_by)
        .input('created_by_user_id', sql.BigInt, audit.created_by_user_id)
        .input('created_by_author_id', sql.BigInt, audit.created_by_author_id)
        .execute('dbo.p_RegisterIdentityEvent');
    } catch (ledgerErr) {
      console.error('[LEDGER] Erro ao registrar AUTHOR_UPDATED:', ledgerErr);
      // não falha a atualização do autor se só o ledger deu erro
    }

    res.json(updated);
  } catch (err) {
    console.error('[PUT /authors/:id] Erro SQL:', err);
    res.status(500).json({ error: 'Erro ao atualizar autor.' });
  }
});

/**
 * GET /authors/:id/timeline
 * Linha do tempo de eventos de um autor no identity_ledger.
 */
router.get('/:id/timeline', async (req, res) => {
  const authorId = parseInt(req.params.id, 10);

  if (Number.isNaN(authorId)) {
    return res.status(400).json({ error: 'authorId inválido.' });
  }

  try {
    const pool = await getPool();

    const result = await pool.request()
      .input('entity_id', sql.BigInt, authorId)
      .query(`
        SELECT
          ledger_id,
          event_type,
          entity_type,
          entity_id,
          version_number,
          payload_json,
          created_at,
          created_by
        FROM dbo.identity_ledger
        WHERE entity_type = 'AUTHOR'
          AND entity_id   = @entity_id
        ORDER BY version_number ASC, created_at ASC, ledger_id ASC;
      `);

    const timeline = result.recordset.map(row => {
      let payload = null;
      try {
        payload = JSON.parse(row.payload_json);
      } catch (e) {
        payload = null;
      }

      if (row.event_type === 'AUTHOR_CREATED' && payload) {
        return {
          ledger_id: row.ledger_id,
          version: row.version_number,
          event: row.event_type,
          timestamp: row.created_at,
          created_by: row.created_by,
          author_id: row.entity_id,
          author_code: payload.author_code,
          full_name: payload.full_name
        };
      }

      if (row.event_type === 'AUTHOR_UPDATED' && payload) {
        const before = payload.before || null;
        const after  = payload.after  || null;

        const changed_fields = [];
        if (before && after) {
          for (const key of Object.keys(after)) {
            if (
              Object.prototype.hasOwnProperty.call(before, key) &&
              before[key] !== after[key]
            ) {
              changed_fields.push(key);
            }
          }
        }

        return {
          ledger_id: row.ledger_id,
          version: row.version_number,
          event: row.event_type,
          timestamp: row.created_at,
          created_by: row.created_by,
          before,
          after,
          changed_fields
        };
      }

      // fallback genérico
      return {
        ledger_id: row.ledger_id,
        version: row.version_number,
        event: row.event_type,
        timestamp: row.created_at,
        created_by: row.created_by,
        payload
      };
    });

    res.json({
      author_id: authorId,
      total_events: timeline.length,
      timeline
    });
  } catch (err) {
    console.error('[GET /authors/:id/timeline] Erro SQL:', err);
    res.status(500).json({ error: 'Erro ao obter timeline do autor.' });
  }
});

export default router;
