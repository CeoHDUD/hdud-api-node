// HDUD Admin — Implementação 04 | Authorization Engine
// Rota mínima de prova. Não representa domínio administrativo de produto.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";

const router = Router();

router.get(
  "/",
  authRequired,
  requireAdminPermission("ADMIN_PROBE_READ"),
  (req, res) => {
    return res.json({
      ok: true,
      permission: req.adminAuthorization?.permission_code || "ADMIN_PROBE_READ",
      session_context: req.user?.session_context || null,
    });
  }
);

export default router;
