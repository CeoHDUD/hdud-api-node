// middleware/requireAuthor.js — garante ownership das memórias

import { getPool, sql } from '../db.js';
import { userHasRole, ROLES } from './roles.js';

/**
 * Middleware para garantir que a memória pertence ao autor autenticado.
 *
 * options:
 *  - paramName: nome do parâmetro na rota que contém o ID da memória (default: "id")
 *  - allowAdmin: se true, AUTHOR_ADMIN pode ignorar ownership
 *  - allowKernel: se true, SYSTEM_KERNEL pode ignorar ownership (já é padrão no RBAC)
 */
export function requireMemoryOwnership(options = {}) {
  const {
    paramName = 'id',
    allowAdmin = true,
    allowKernel = true,
  } = options;

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Não autenticado.' });
      }

      const memoryId = req.params[paramName];

      if (!memoryId) {
        return res.status(400).json({
          error: `Parâmetro de memória "${paramName}" não informado.`,
        });
      }

      const pool = await getPool();
      const result = await pool
        .request()
        .input('memory_id', sql.Int, Number(memoryId))
        .query(`
          SELECT memory_id, author_id
          FROM identity_memory
          WHERE memory_id = @memory_id
        `);

      if (!result.recordset || result.recordset.length === 0) {
        return res.status(404).json({
          error: 'Memória não encontrada.',
        });
      }

      const memory = result.recordset[0];

      // Se usuário for ADMIN ou KERNEL, pode ignorar ownership (conforme flags)
      if (
        (allowAdmin && userHasRole(req.user, ROLES.AUTHOR_ADMIN)) ||
        (allowKernel && userHasRole(req.user, ROLES.SYSTEM_KERNEL))
      ) {
        req.memory = memory; // deixamos disponível para o handler
        return next();
      }

      // Regra padrão: o autor do token deve ser o autor da memória
      if (Number(memory.author_id) !== Number(req.user.author_id)) {
        return res.status(403).json({
          error: 'Você não tem permissão para acessar ou modificar esta memória.',
        });
      }

      // Tudo certo, segue
      req.memory = memory;
      return next();
    } catch (err) {
      console.error('Erro ao verificar ownership da memória:', err);
      return res.status(500).json({
        error: 'Erro ao verificar propriedade da memória.',
      });
    }
  };
}

/**
 * (Opcional) Middleware para garantir que o body.author_id, se vier,
 * seja igual ao autor do token — ou que o usuário tenha permissão superior.
 */
export function enforceAuthorOnBody() {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }

    const bodyAuthorId = req.body.author_id;

    // Se não veio author_id no body, definimos automaticamente como o autor do token
    if (bodyAuthorId == null) {
      req.body.author_id = req.user.author_id;
      return next();
    }

    // Se usuário for ADMIN ou KERNEL, deixamos alterar (casos de moderação/sistema)
    if (userHasRole(req.user, ROLES.AUTHOR_ADMIN, ROLES.SYSTEM_KERNEL)) {
      return next();
    }

    // Caso normal: autor do body deve ser igual ao autor do token
    if (Number(bodyAuthorId) !== Number(req.user.author_id)) {
      return res.status(403).json({
        error: 'Você não pode criar ou alterar memórias em nome de outro autor.',
      });
    }

    return next();
  };
}
