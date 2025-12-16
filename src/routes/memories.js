// routes/memories.js — HDUD API v0.7 (corrigido: Unicode garantido + title NVARCHAR(500))

import { Router } from 'express';
import { getPool, sql } from '../db.js';
import { getAuditContext } from '../utils/audit.js';

// 🔐 Middlewares de segurança
import { authenticate } from '../middleware/auth.js';
import { requireMemoryOwnership } from '../middleware/requireAuthor.js';
import { requireRoles, ROLES } from '../middleware/roles.js';

const router = Router();

// Todas as rotas abaixo exigem token JWT válido
router.use(authenticate);

/**
 * GET /authors/:id/memories
 * Lista memórias de um autor
 */
router.get(
  '/authors/:id/memories',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  async (req, res) => {
    const authorId = parseInt(req.params.id, 10);

    if (Number.isNaN(authorId)) {
      return res.status(400).json({ error: 'authorId inválido.' });
    }

    // 🚫 Ownership: autor comum só pode ver as próprias memórias
    const userAuthorId = Number(req.user?.author_id);
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdminOrKernel =
      roles.includes(ROLES.AUTHOR_ADMIN) || roles.includes(ROLES.SYSTEM_KERNEL);

    if (!isAdminOrKernel && userAuthorId !== authorId) {
      return res.status(403).json({
        error: 'Você não pode listar memórias de outro autor.',
      });
    }

    try {
      const pool = await getPool();
      const result = await pool.request()
        .input('author_id', sql.Int, authorId)
        .query(`
          SELECT memory_id,
                 author_id,
                 title,
                 content,
                 created_at,
                 version_number,
                 is_deleted
          FROM dbo.identity_memory
          WHERE author_id = @author_id
            AND is_deleted = 0
          ORDER BY created_at DESC;
        `);

      res.json(result.recordset);
    } catch (err) {
      console.error('[GET /authors/:id/memories] Erro SQL:', err);
      res.status(500).json({ error: 'Erro ao listar memórias.' });
    }
  }
);

/**
 * POST /authors/:id/memories
 * Cria uma memória nova (versão 1)
 */
router.post(
  '/authors/:id/memories',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  async (req, res) => {
    const authorId = parseInt(req.params.id, 10);
    const { title, content } = req.body;

    if (Number.isNaN(authorId)) {
      return res.status(400).json({ error: 'authorId inválido.' });
    }
    if (!title || !content) {
      return res.status(400).json({ error: 'Campos obrigatórios: title, content' });
    }

    // 🚫 Ownership: autor comum só pode criar memórias em seu próprio author_id
    const userAuthorId = Number(req.user?.author_id);
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdminOrKernel =
      roles.includes(ROLES.AUTHOR_ADMIN) || roles.includes(ROLES.SYSTEM_KERNEL);

    if (!isAdminOrKernel && userAuthorId !== authorId) {
      return res.status(403).json({
        error: 'Você não pode criar memórias em nome de outro autor.',
      });
    }

    try {
      const pool = await getPool();
      const audit = getAuditContext(req);

      // 1) Insere a memória na tabela principal
      // ✅ Unicode garantido: title/content sempre NVARCHAR
      const insertResult = await pool.request()
        .input('author_id', sql.Int, authorId)
        .input('title', sql.NVarChar(500), String(title))
        .input('content', sql.NVarChar(sql.MAX), String(content))
        .query(`
          INSERT INTO dbo.identity_memory (author_id, title, content)
          OUTPUT INSERTED.memory_id,
                 INSERTED.author_id,
                 INSERTED.title,
                 INSERTED.content,
                 INSERTED.created_at,
                 INSERTED.version_number,
                 INSERTED.is_deleted
          VALUES (@author_id, @title, @content);
        `);

      const memory = insertResult.recordset[0];

      // 2) Monta o JSON de payload para o ledger
      const payload = {
        memory_id: memory.memory_id,
        author_id: memory.author_id,
        title: memory.title,
        content: memory.content,
        created_at: memory.created_at,
        version_number: memory.version_number
      };

      // 3) Registra o evento MEMORY_CREATED
      try {
        await pool.request()
          .input('event_type', sql.VarChar(50), 'MEMORY_CREATED')
          .input('entity_type', sql.VarChar(50), 'MEMORY')
          .input('entity_id', sql.BigInt, memory.memory_id)
          .input('version_number', sql.Int, memory.version_number || 1)
          // ✅ payload em NVARCHAR(MAX)
          .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(payload))
          .input('created_by', sql.VarChar(100), audit.created_by)
          .input('created_by_user_id', sql.BigInt, audit.created_by_user_id)
          .input('created_by_author_id', sql.BigInt, audit.created_by_author_id)
          .execute('dbo.p_RegisterIdentityEvent');
      } catch (ledgerErr) {
        console.error('[LEDGER] Erro ao registrar MEMORY_CREATED:', ledgerErr);
      }

      res.status(201).json(memory);
    } catch (err) {
      console.error('[POST /authors/:id/memories] Erro SQL:', err);
      res.status(500).json({ error: 'Erro ao criar memória.' });
    }
  }
);

/**
 * ✅ GET /memories/:id
 * Retorna o detalhe da memória atual (versão vigente)
 */
router.get(
  '/memories/:id',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  requireMemoryOwnership({ paramName: 'id', allowAdmin: true, allowKernel: true }),
  async (req, res) => {
    const memoryId = parseInt(req.params.id, 10);

    if (Number.isNaN(memoryId)) {
      return res.status(400).json({ error: 'memoryId inválido.' });
    }

    try {
      const pool = await getPool();

      const result = await pool.request()
        .input('memory_id', sql.Int, memoryId)
        .query(`
          SELECT TOP 1
                 memory_id,
                 author_id,
                 title,
                 content,
                 created_at,
                 version_number,
                 is_deleted
          FROM dbo.identity_memory
          WHERE memory_id = @memory_id
            AND is_deleted = 0;
        `);

      if (result.recordset.length === 0) {
        return res.status(404).json({ error: 'Memória não encontrada.' });
      }

      const memory = result.recordset[0];

      return res.json({
        ...memory,
        meta: {
          can_edit: true,
          current_version: memory.version_number || 1
        }
      });
    } catch (err) {
      console.error('[GET /memories/:id] Erro SQL:', err);
      return res.status(500).json({ error: 'Erro ao obter memória.' });
    }
  }
);

/**
 * PUT /memories/:id
 * Atualiza uma memória existente e cria nova versão
 */
router.put(
  '/memories/:id',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  requireMemoryOwnership({ paramName: 'id', allowAdmin: true, allowKernel: true }),
  async (req, res) => {
    const memoryId = parseInt(req.params.id, 10);
    const { title, content } = req.body;

    if (Number.isNaN(memoryId)) {
      return res.status(400).json({ error: 'memoryId inválido.' });
    }
    if (!title && !content) {
      return res.status(400).json({
        error: 'Informe pelo menos um campo para atualizar: title ou content.'
      });
    }

    try {
      const pool = await getPool();
      const audit = getAuditContext(req);

      // 1) Busca a memória atual
      const currentResult = await pool.request()
        .input('memory_id', sql.Int, memoryId)
        .query(`
          SELECT TOP 1
                 memory_id,
                 author_id,
                 title,
                 content,
                 created_at,
                 version_number,
                 is_deleted
          FROM dbo.identity_memory
          WHERE memory_id = @memory_id
            AND is_deleted = 0;
        `);

      if (currentResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Memória não encontrada.' });
      }

      const current = currentResult.recordset[0];

      // 2) Define novos valores
      const newTitle = title ?? current.title;
      const newContent = content ?? current.content;
      const newVersion = (current.version_number || 1) + 1;

      // 3) Atualiza a memória
      // ✅ Unicode garantido: title/content sempre NVARCHAR
      const updateResult = await pool.request()
        .input('memory_id', sql.Int, memoryId)
        .input('title', sql.NVarChar(500), String(newTitle))
        .input('content', sql.NVarChar(sql.MAX), String(newContent))
        .input('version_number', sql.Int, newVersion)
        .query(`
          UPDATE dbo.identity_memory
          SET title = @title,
              content = @content,
              version_number = @version_number
          OUTPUT INSERTED.memory_id,
                 INSERTED.author_id,
                 INSERTED.title,
                 INSERTED.content,
                 INSERTED.created_at,
                 INSERTED.version_number,
                 INSERTED.is_deleted
          WHERE memory_id = @memory_id
            AND is_deleted = 0;
        `);

      if (updateResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Memória não encontrada ao atualizar.' });
      }

      const updated = updateResult.recordset[0];

      // 4) Payload before/after
      const payload = {
        before: {
          memory_id: current.memory_id,
          author_id: current.author_id,
          title: current.title,
          content: current.content,
          created_at: current.created_at,
          version_number: current.version_number
        },
        after: {
          memory_id: updated.memory_id,
          author_id: updated.author_id,
          title: updated.title,
          content: updated.content,
          created_at: updated.created_at,
          version_number: updated.version_number
        }
      };

      // 5) Registra MEMORY_UPDATED
      try {
        await pool.request()
          .input('event_type', sql.VarChar(50), 'MEMORY_UPDATED')
          .input('entity_type', sql.VarChar(50), 'MEMORY')
          .input('entity_id', sql.BigInt, updated.memory_id)
          .input('version_number', sql.Int, updated.version_number)
          .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(payload))
          .input('created_by', sql.VarChar(100), audit.created_by)
          .input('created_by_user_id', sql.BigInt, audit.created_by_user_id)
          .input('created_by_author_id', sql.BigInt, audit.created_by_author_id)
          .execute('dbo.p_RegisterIdentityEvent');
      } catch (ledgerErr) {
        console.error('[LEDGER] Erro ao registrar MEMORY_UPDATED:', ledgerErr);
      }

      res.json(updated);
    } catch (err) {
      console.error('[PUT /memories/:id] Erro SQL:', err);
      res.status(500).json({ error: 'Erro ao atualizar memória.' });
    }
  }
);

/**
 * GET /memories/:id/versions
 * Linha direta do ledger (bruta)
 */
router.get(
  '/memories/:id/versions',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  requireMemoryOwnership({ paramName: 'id', allowAdmin: true, allowKernel: true }),
  async (req, res) => {
    const memoryId = parseInt(req.params.id, 10);

    if (Number.isNaN(memoryId)) {
      return res.status(400).json({ error: 'memoryId inválido.' });
    }

    try {
      const pool = await getPool();

      const result = await pool.request()
        .input('entity_id', sql.BigInt, memoryId)
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
          WHERE entity_type = 'MEMORY'
            AND entity_id   = @entity_id
          ORDER BY version_number ASC, created_at ASC, ledger_id ASC;
        `);

      const timeline = result.recordset.map(row => {
        let parsedPayload = null;
        try {
          parsedPayload = JSON.parse(row.payload_json);
        } catch (e) {
          parsedPayload = null;
        }

        return {
          ledger_id: row.ledger_id,
          event_type: row.event_type,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          version_number: row.version_number,
          created_at: row.created_at,
          created_by: row.created_by,
          payload: parsedPayload,
          raw_payload: parsedPayload ? undefined : row.payload_json
        };
      });

      res.json(timeline);
    } catch (err) {
      console.error('[GET /memories/:id/versions] Erro SQL:', err);
      res.status(500).json({ error: 'Erro ao obter versões da memória.' });
    }
  }
);

/**
 * POST /memories/:id/rollback/:version
 * Restaura uma versão antiga como nova versão atual.
 */
router.post(
  '/memories/:id/rollback/:version',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  requireMemoryOwnership({ paramName: 'id', allowAdmin: true, allowKernel: true }),
  async (req, res) => {
    const memoryId = parseInt(req.params.id, 10);
    const targetVersion = parseInt(req.params.version, 10);

    if (Number.isNaN(memoryId) || Number.isNaN(targetVersion)) {
      return res.status(400).json({ error: 'IDs inválidos.' });
    }

    try {
      const pool = await getPool();
      const audit = getAuditContext(req);

      // 1) Snapshot no ledger (somente CREATED/UPDATED)
      const snapshotResult = await pool.request()
        .input('entity_id', sql.BigInt, memoryId)
        .input('version_number', sql.Int, targetVersion)
        .query(`
          SELECT TOP 1 payload_json, event_type
          FROM dbo.identity_ledger
          WHERE entity_type = 'MEMORY'
            AND entity_id   = @entity_id
            AND version_number = @version_number
            AND event_type IN ('MEMORY_CREATED', 'MEMORY_UPDATED')
          ORDER BY ledger_id ASC;
        `);

      if (snapshotResult.recordset.length === 0) {
        return res.status(404).json({
          error: `Versão ${targetVersion} não encontrada para esta memória (ou não é um snapshot restaurável).`
        });
      }

      const rawSnapshot = snapshotResult.recordset[0].payload_json;
      let snapshot;
      try {
        snapshot = JSON.parse(rawSnapshot);
      } catch (e) {
        return res.status(500).json({
          error: 'Snapshot em formato inválido para rollback.'
        });
      }

      const restored = snapshot.after ?? snapshot;

      const restoredTitle = restored.title;
      const restoredContent = restored.content;

      // 2) Busca memória atual
      const currentResult = await pool.request()
        .input('memory_id', sql.Int, memoryId)
        .query(`
          SELECT TOP 1 memory_id, author_id, title, content, version_number
          FROM dbo.identity_memory
          WHERE memory_id = @memory_id
            AND is_deleted = 0;
        `);

      if (currentResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Memória não encontrada.' });
      }

      const current = currentResult.recordset[0];
      const newVersion = (current.version_number || 1) + 1;

      // 3) Atualiza tabela principal com a versão restaurada
      // ✅ Unicode garantido: title/content sempre NVARCHAR
      const updatedResult = await pool.request()
        .input('memory_id', sql.Int, memoryId)
        .input('title', sql.NVarChar(500), String(restoredTitle))
        .input('content', sql.NVarChar(sql.MAX), String(restoredContent))
        .input('version_number', sql.Int, newVersion)
        .query(`
          UPDATE dbo.identity_memory
          SET title = @title,
              content = @content,
              version_number = @version_number
          OUTPUT INSERTED.*
          WHERE memory_id = @memory_id
            AND is_deleted = 0;
        `);

      if (updatedResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Memória não encontrada ao aplicar rollback.' });
      }

      const updated = updatedResult.recordset[0];

      // 4) Registrar no ledger
      const payload = {
        memory_id: memoryId,
        restored_version: targetVersion,
        new_version: newVersion,
        title_before_rollback: current.title,
        title_restored: restoredTitle,
        content_before_rollback: current.content,
        content_restored: restoredContent
      };

      await pool.request()
        .input('event_type', sql.VarChar(50), 'MEMORY_ROLLBACK')
        .input('entity_type', sql.VarChar(50), 'MEMORY')
        .input('entity_id', sql.BigInt, memoryId)
        .input('version_number', sql.Int, newVersion)
        .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .input('created_by', sql.VarChar(100), audit.created_by)
        .input('created_by_user_id', sql.BigInt, audit.created_by_user_id)
        .input('created_by_author_id', sql.BigInt, audit.created_by_author_id)
        .execute('dbo.p_RegisterIdentityEvent');

      res.json({
        message: `Rollback realizado com sucesso para a versão ${targetVersion}.`,
        updated
      });

    } catch (err) {
      console.error('[POST /memories/:id/rollback/:version] Erro SQL:', err);
      res.status(500).json({ error: 'Erro ao realizar rollback.' });
    }
  }
);

/**
 * GET /memories/:id/timeline
 * Timeline consolidada, amigável para o app
 */
router.get(
  '/memories/:id/timeline',
  requireRoles(ROLES.AUTHOR_SELF, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL),
  requireMemoryOwnership({ paramName: 'id', allowAdmin: true, allowKernel: true }),
  async (req, res) => {
    const memoryId = parseInt(req.params.id, 10);

    if (Number.isNaN(memoryId)) {
      return res.status(400).json({ error: 'memoryId inválido.' });
    }

    try {
      const pool = await getPool();

      const result = await pool.request()
        .input('entity_id', sql.BigInt, memoryId)
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
          WHERE entity_type = 'MEMORY'
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

        if (row.event_type === 'MEMORY_CREATED' && payload) {
          return {
            ledger_id: row.ledger_id,
            version: row.version_number,
            event: row.event_type,
            timestamp: row.created_at,
            created_by: row.created_by,
            memory_id: row.entity_id,
            title: payload.title,
            content: payload.content
          };
        }

        if (row.event_type === 'MEMORY_UPDATED' && payload) {
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

        if (row.event_type === 'MEMORY_ROLLBACK' && payload) {
          return {
            ledger_id: row.ledger_id,
            version: row.version_number,
            event: row.event_type,
            timestamp: row.created_at,
            created_by: row.created_by,
            restored_from_version: payload.restored_version,
            new_version: payload.new_version,
            title_restored: payload.title_restored ?? null,
            content_restored: payload.content_restored ?? null
          };
        }

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
        memory_id: memoryId,
        total_versions: timeline.length,
        timeline
      });
    } catch (err) {
      console.error('[GET /memories/:id/timeline] Erro SQL:', err);
      res.status(500).json({ error: 'Erro ao obter timeline da memória.' });
    }
  }
);

export default router;
