// C:\HDUD_DATA\hdud-api-node\src\routes\me.js

import express from "express";
import { authenticate } from "../middleware/auth.js";
import { getPool, sql } from "../db.js";

const router = express.Router();

function pickFirstInt(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function resolveUserId(req) {
  const directUserId = pickFirstInt(req.user, ["user_id", "userId", "id", "uid"]);
  if (directUserId != null) return directUserId;

  const subAsInt = pickFirstInt(req.user, ["sub"]);
  if (subAsInt != null) return subAsInt;

  const authorId = pickFirstInt(req.user, ["author_id"]);
  if (authorId != null) return authorId;

  return null;
}

function addOneMonthUtc(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;

  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + 1);

  return out;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rankPlan(planRow) {
  if (!planRow) return 0;

  const price = Number(planRow.price_cents || 0);
  const monthly = Number(planRow.monthly_seconds || 0);
  const perAudio = Number(planRow.max_audio_seconds || 0);

  return price * 1000000 + monthly * 1000 + perAudio;
}

function isCancelLikePlanCode(planCode) {
  const code = String(planCode || "").trim().toUpperCase();
  return ["CANCEL", "CANCELLED", "CANCELED"].includes(code);
}

function shouldTreatAsCancellation(currentPlanRow, targetPlanRow) {
  const currentCode = String(currentPlanRow?.code || "").trim().toUpperCase();
  const targetCode = String(targetPlanRow?.code || "").trim().toUpperCase();

  if (isCancelLikePlanCode(targetCode)) return true;

  if (targetCode === "FREE" && currentCode && currentCode !== "FREE") {
    return true;
  }

  return false;
}

function buildUsageFallback(planRow = null) {
  return {
    reference_year: new Date().getFullYear(),
    reference_month: new Date().getMonth() + 1,
    consumed_seconds: 0,
    reserved_seconds: 0,
    remaining_seconds: safeNumber(planRow?.monthly_seconds || 0),
    audio_count: 0,
    plan_code: String(planRow?.code || ""),
    plan_name: String(planRow?.name || ""),
    max_audio_seconds: safeNumber(planRow?.max_audio_seconds || 0),
    monthly_seconds: safeNumber(planRow?.monthly_seconds || 0),
  };
}

async function getPlanByCode(pool, planCode) {
  const result = await pool
    .request()
    .input("plan_code", sql.VarChar(30), String(planCode || "").trim().toUpperCase())
    .query(`
      SELECT TOP 1
          sp.plan_id,
          sp.code,
          sp.name,
          sp.max_audio_seconds,
          sp.monthly_seconds,
          sp.price_cents,
          sp.currency_code,
          sp.is_active
      FROM dbo.subscription_plan sp
      WHERE sp.code = @plan_code
        AND ISNULL(sp.is_active, 1) = 1
      ORDER BY sp.plan_id ASC;
    `);

  return result?.recordset?.[0] || null;
}

async function getActiveSubscription(pool, userId) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .query(`
      SELECT TOP 1
          us.user_subscription_id,
          us.user_id,
          us.plan_id,
          us.status,
          us.starts_at,
          us.ends_at,
          us.auto_renew,
          us.created_at,
          us.updated_at,
          sp.code,
          sp.name,
          sp.max_audio_seconds,
          sp.monthly_seconds,
          sp.price_cents,
          sp.currency_code
      FROM dbo.user_subscription us
      INNER JOIN dbo.subscription_plan sp
          ON sp.plan_id = us.plan_id
      WHERE us.user_id = @user_id
        AND us.status = 'ACTIVE'
      ORDER BY us.created_at DESC, us.user_subscription_id DESC;
    `);

  return result?.recordset?.[0] || null;
}

async function getActivePlan(pool, userId) {
  const activeSubscription = await getActiveSubscription(pool, userId);

  if (!activeSubscription) return null;

  return {
    plan_id: activeSubscription.plan_id,
    code: activeSubscription.code,
    name: activeSubscription.name,
    max_audio_seconds: activeSubscription.max_audio_seconds,
    monthly_seconds: activeSubscription.monthly_seconds,
  };
}

async function getUsageFromProcedure(pool, userId) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .execute("dbo.p_GetMyUsage");

  return result?.recordset?.[0] || null;
}

async function getUsageSafe(pool, userId, planRow = null) {
  try {
    const usageRow = await getUsageFromProcedure(pool, userId);
    return usageRow || buildUsageFallback(planRow);
  } catch (err) {
    console.error("[GET_USAGE_SAFE] erro ao executar dbo.p_GetMyUsage:", err);
    return buildUsageFallback(planRow);
  }
}

async function getPendingSubscriptionChange(pool, userId) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .query(`
      SELECT TOP 1
          usc.subscription_change_id,
          usc.user_subscription_id,
          usc.user_id,
          usc.current_plan_id,
          usc.target_plan_id,
          usc.change_type,
          usc.status,
          usc.effective_at,
          usc.requested_at,
          usc.applied_at,
          usc.cancelled_at,
          usc.metadata_json,
          current_sp.code AS current_plan_code,
          current_sp.name AS current_plan_name,
          target_sp.code AS target_plan_code,
          target_sp.name AS target_plan_name
      FROM dbo.user_subscription_change usc
      LEFT JOIN dbo.subscription_plan current_sp
          ON current_sp.plan_id = usc.current_plan_id
      LEFT JOIN dbo.subscription_plan target_sp
          ON target_sp.plan_id = usc.target_plan_id
      WHERE usc.user_id = @user_id
        AND usc.status = 'PENDING'
      ORDER BY usc.requested_at DESC, usc.subscription_change_id DESC;
    `);

  return result?.recordset?.[0] || null;
}

function buildUsageResponse(planRow, usageRow) {
  const maxAudioSeconds =
    planRow?.max_audio_seconds != null
      ? safeNumber(planRow.max_audio_seconds)
      : safeNumber(usageRow?.max_audio_seconds || 0);

  const monthlySeconds =
    planRow?.monthly_seconds != null
      ? safeNumber(planRow.monthly_seconds)
      : safeNumber(usageRow?.monthly_seconds || 0);

  const consumedSeconds = Math.max(0, safeNumber(usageRow?.consumed_seconds || 0));
  const reservedSeconds = Math.max(0, safeNumber(usageRow?.reserved_seconds || 0));

  let remainingSeconds;

  if (usageRow?.remaining_seconds != null && planRow == null) {
    remainingSeconds = Math.max(0, safeNumber(usageRow.remaining_seconds || 0));
  } else {
    remainingSeconds = Math.max(
      0,
      monthlySeconds - consumedSeconds - reservedSeconds
    );
  }

  return {
    ok: true,
    plan: {
      code: String(planRow?.code || usageRow?.plan_code || ""),
      name: String(planRow?.name || usageRow?.plan_name || ""),
      max_audio_seconds: maxAudioSeconds,
      monthly_seconds: monthlySeconds,
    },
    usage: {
      reference_year: safeNumber(usageRow?.reference_year || 0),
      reference_month: safeNumber(usageRow?.reference_month || 0),
      consumed_seconds: consumedSeconds,
      reserved_seconds: reservedSeconds,
      remaining_seconds: remainingSeconds,
      audio_count: Math.max(0, safeNumber(usageRow?.audio_count || 0)),
    },
  };
}

function buildSubscriptionPayload(activeSubscription, pendingChange) {
  if (!activeSubscription && !pendingChange) {
    return null;
  }

  const startsAt = activeSubscription?.starts_at || null;
  const currentPeriodStart = toIsoOrNull(startsAt);
  const currentPeriodEnd = toIsoOrNull(addOneMonthUtc(startsAt));

  let status = activeSubscription ? "ACTIVE" : "CANCELLED";
  let statusLabel = "Ativa";
  let pendingPayload = null;

  if (pendingChange) {
    if (pendingChange.change_type === "DOWNGRADE_NEXT_CYCLE") {
      status = "PENDING_DOWNGRADE";
      statusLabel = "Downgrade agendado";
    } else if (pendingChange.change_type === "CANCEL_AT_PERIOD_END") {
      status = "PENDING_CANCELLATION";
      statusLabel = "Cancelamento agendado";
    } else {
      statusLabel = "Mudança agendada";
    }

    pendingPayload = {
      change_id: Number(pendingChange.subscription_change_id),
      status: pendingChange.status ? String(pendingChange.status) : "PENDING",
      type: String(pendingChange.change_type || ""),
      current_plan_code: pendingChange.current_plan_code
        ? String(pendingChange.current_plan_code)
        : null,
      current_plan_name: pendingChange.current_plan_name
        ? String(pendingChange.current_plan_name)
        : null,
      next_plan_code: pendingChange.target_plan_code
        ? String(pendingChange.target_plan_code)
        : null,
      next_plan_name: pendingChange.target_plan_name
        ? String(pendingChange.target_plan_name)
        : null,
      effective_at: toIsoOrNull(pendingChange.effective_at),
      requested_at: toIsoOrNull(pendingChange.requested_at),
      applied_at: toIsoOrNull(pendingChange.applied_at),
      cancelled_at: toIsoOrNull(pendingChange.cancelled_at),
    };
  } else if (status === "ACTIVE") {
    statusLabel = "Ativa";
  }

  return {
    status,
    status_label: statusLabel,
    current_plan_code: activeSubscription?.code
      ? String(activeSubscription.code)
      : null,
    current_plan_name: activeSubscription?.name
      ? String(activeSubscription.name)
      : null,
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    pending_change: pendingPayload,
  };
}

async function cancelPendingChanges(pool, userId) {
  await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .query(`
      UPDATE dbo.user_subscription_change
      SET
          status = 'CANCELLED',
          cancelled_at = SYSUTCDATETIME()
      WHERE user_id = @user_id
        AND status = 'PENDING';
    `);
}

async function insertPendingChange(
  pool,
  {
    userId,
    userSubscriptionId,
    currentPlanId,
    targetPlanId,
    changeType,
    effectiveAt,
    metadataJson,
  }
) {
  await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("user_subscription_id", sql.BigInt, Number(userSubscriptionId))
    .input("current_plan_id", sql.Int, Number(currentPlanId))
    .input("target_plan_id", sql.Int, targetPlanId != null ? Number(targetPlanId) : null)
    .input("change_type", sql.VarChar(30), String(changeType))
    .input("effective_at", sql.DateTime2, effectiveAt)
    .input("metadata_json", sql.NVarChar(sql.MAX), metadataJson || null)
    .query(`
      INSERT INTO dbo.user_subscription_change
      (
        user_subscription_id,
        user_id,
        current_plan_id,
        target_plan_id,
        change_type,
        status,
        effective_at,
        requested_at,
        metadata_json
      )
      VALUES
      (
        @user_subscription_id,
        @user_id,
        @current_plan_id,
        @target_plan_id,
        @change_type,
        'PENDING',
        @effective_at,
        SYSUTCDATETIME(),
        @metadata_json
      );
    `);
}

router.get("/usage", authenticate, async (req, res) => {
  try {
    const userId = resolveUserId(req);

    if (userId == null) {
      return res.status(401).json({ error: "userId não encontrado no token." });
    }

    const pool = await getPool();
    const planRow = await getActivePlan(pool, userId);
    const usageRow = await getUsageSafe(pool, userId, planRow);

    if (!planRow && !usageRow) {
      return res.status(404).json({ error: "Uso do plano não encontrado." });
    }

    return res.json(buildUsageResponse(planRow, usageRow));
  } catch (err) {
    console.error("[GET /me/usage] erro:", err);
    return res.status(500).json({
      error: "Erro ao carregar uso do plano.",
      detail: err?.message || null,
    });
  }
});

router.get("/subscription", authenticate, async (req, res) => {
  try {
    const userId = resolveUserId(req);

    if (userId == null) {
      return res.status(401).json({ error: "userId não encontrado no token." });
    }

    const pool = await getPool();

    const [activeSubscription, pendingChange] = await Promise.all([
      getActiveSubscription(pool, userId),
      getPendingSubscriptionChange(pool, userId),
    ]);

    if (!activeSubscription && !pendingChange) {
      return res.status(404).json({
        error: "Assinatura não encontrada.",
      });
    }

    return res.json({
      ok: true,
      subscription: buildSubscriptionPayload(activeSubscription, pendingChange),
    });
  } catch (err) {
    console.error("[GET /me/subscription] erro:", err);
    return res.status(500).json({
      error: "Erro ao carregar assinatura.",
      detail: err?.message || null,
    });
  }
});

router.post("/subscription/change", authenticate, async (req, res) => {
  try {
    const userId = resolveUserId(req);

    if (userId == null) {
      return res.status(401).json({ error: "userId não encontrado no token." });
    }

    const requestedPlanCode = String(req.body?.plan_code || "")
      .trim()
      .toUpperCase();

    if (!requestedPlanCode) {
      return res.status(400).json({
        error: "plan_code é obrigatório.",
      });
    }

    const pool = await getPool();

    const currentSubscription = await getActiveSubscription(pool, userId);

    if (!currentSubscription) {
      const targetPlan = await getPlanByCode(pool, requestedPlanCode);

      if (!targetPlan) {
        return res.status(400).json({
          error: "Plano inválido ou inativo.",
        });
      }

      await cancelPendingChanges(pool, userId);

      await pool
        .request()
        .input("user_id", sql.BigInt, Number(userId))
        .input("plan_code", sql.VarChar(30), requestedPlanCode)
        .execute("dbo.p_ChangeUserPlan");

      const [newSubscription, usageRow] = await Promise.all([
        getActiveSubscription(pool, userId),
        getUsageSafe(
          pool,
          userId,
          {
            code: targetPlan.code,
            name: targetPlan.name,
            max_audio_seconds: targetPlan.max_audio_seconds,
            monthly_seconds: targetPlan.monthly_seconds,
          }
        ),
      ]);

      return res.json({
        ok: true,
        action: "UPGRADE_IMMEDIATE",
        message: "Plano aplicado imediatamente.",
        subscription: buildSubscriptionPayload(newSubscription, null),
        usage: buildUsageResponse(
          newSubscription
            ? {
                code: newSubscription.code,
                name: newSubscription.name,
                max_audio_seconds: newSubscription.max_audio_seconds,
                monthly_seconds: newSubscription.monthly_seconds,
              }
            : {
                code: targetPlan.code,
                name: targetPlan.name,
                max_audio_seconds: targetPlan.max_audio_seconds,
                monthly_seconds: targetPlan.monthly_seconds,
              },
          usageRow
        ),
      });
    }

    const currentPlanCode = String(currentSubscription.code || "").trim().toUpperCase();
    const targetPlan = await getPlanByCode(pool, requestedPlanCode);

    if (!targetPlan) {
      return res.status(400).json({
        error: "Plano inválido ou inativo.",
      });
    }

    const isCancellation = shouldTreatAsCancellation(currentSubscription, targetPlan);

    if (!isCancellation && requestedPlanCode === currentPlanCode) {
      const [usageRow, pendingChange] = await Promise.all([
        getUsageSafe(
          pool,
          userId,
          {
            code: currentSubscription.code,
            name: currentSubscription.name,
            max_audio_seconds: currentSubscription.max_audio_seconds,
            monthly_seconds: currentSubscription.monthly_seconds,
          }
        ),
        getPendingSubscriptionChange(pool, userId),
      ]);

      return res.json({
        ok: true,
        action: "NO_CHANGE",
        message: "O usuário já está neste plano.",
        subscription: buildSubscriptionPayload(currentSubscription, pendingChange),
        usage: buildUsageResponse(
          {
            code: currentSubscription.code,
            name: currentSubscription.name,
            max_audio_seconds: currentSubscription.max_audio_seconds,
            monthly_seconds: currentSubscription.monthly_seconds,
          },
          usageRow
        ),
      });
    }

    const currentRank = rankPlan(currentSubscription);
    const targetRank = rankPlan(targetPlan);

    if (!isCancellation && targetRank > currentRank) {
      await cancelPendingChanges(pool, userId);

      await pool
        .request()
        .input("user_id", sql.BigInt, Number(userId))
        .input("plan_code", sql.VarChar(30), requestedPlanCode)
        .execute("dbo.p_ChangeUserPlan");

      const [newSubscription, usageRow] = await Promise.all([
        getActiveSubscription(pool, userId),
        getUsageSafe(
          pool,
          userId,
          {
            code: targetPlan.code,
            name: targetPlan.name,
            max_audio_seconds: targetPlan.max_audio_seconds,
            monthly_seconds: targetPlan.monthly_seconds,
          }
        ),
      ]);

      return res.json({
        ok: true,
        action: "UPGRADE_IMMEDIATE",
        message: "Upgrade aplicado imediatamente.",
        subscription: buildSubscriptionPayload(newSubscription, null),
        usage: buildUsageResponse(
          newSubscription
            ? {
                code: newSubscription.code,
                name: newSubscription.name,
                max_audio_seconds: newSubscription.max_audio_seconds,
                monthly_seconds: newSubscription.monthly_seconds,
              }
            : {
                code: targetPlan.code,
                name: targetPlan.name,
                max_audio_seconds: targetPlan.max_audio_seconds,
                monthly_seconds: targetPlan.monthly_seconds,
              },
          usageRow
        ),
      });
    }

    const effectiveAt = addOneMonthUtc(currentSubscription.starts_at);

    if (!effectiveAt) {
      return res.status(500).json({
        error: "Não foi possível calcular o fechamento do ciclo atual.",
      });
    }

    await cancelPendingChanges(pool, userId);

    if (isCancellation) {
      await insertPendingChange(pool, {
        userId,
        userSubscriptionId: currentSubscription.user_subscription_id,
        currentPlanId: currentSubscription.plan_id,
        targetPlanId: targetPlan.plan_id,
        changeType: "CANCEL_AT_PERIOD_END",
        effectiveAt,
        metadataJson: JSON.stringify({
          requested_plan_code: requestedPlanCode,
          compatibility_mode: requestedPlanCode === "FREE",
        }),
      });

      const [usageRow, pendingChange] = await Promise.all([
        getUsageSafe(
          pool,
          userId,
          {
            code: currentSubscription.code,
            name: currentSubscription.name,
            max_audio_seconds: currentSubscription.max_audio_seconds,
            monthly_seconds: currentSubscription.monthly_seconds,
          }
        ),
        getPendingSubscriptionChange(pool, userId),
      ]);

      return res.json({
        ok: true,
        action: "CANCEL_AT_PERIOD_END",
        message: "Cancelamento agendado para o fim do ciclo vigente.",
        subscription: buildSubscriptionPayload(currentSubscription, pendingChange),
        usage: buildUsageResponse(
          {
            code: currentSubscription.code,
            name: currentSubscription.name,
            max_audio_seconds: currentSubscription.max_audio_seconds,
            monthly_seconds: currentSubscription.monthly_seconds,
          },
          usageRow
        ),
      });
    }

    await insertPendingChange(pool, {
      userId,
      userSubscriptionId: currentSubscription.user_subscription_id,
      currentPlanId: currentSubscription.plan_id,
      targetPlanId: targetPlan.plan_id,
      changeType: "DOWNGRADE_NEXT_CYCLE",
      effectiveAt,
      metadataJson: JSON.stringify({
        requested_plan_code: requestedPlanCode,
      }),
    });

    const [usageRow, pendingChange] = await Promise.all([
      getUsageSafe(
        pool,
        userId,
        {
          code: currentSubscription.code,
          name: currentSubscription.name,
          max_audio_seconds: currentSubscription.max_audio_seconds,
          monthly_seconds: currentSubscription.monthly_seconds,
        }
      ),
      getPendingSubscriptionChange(pool, userId),
    ]);

    return res.json({
      ok: true,
      action: "DOWNGRADE_NEXT_CYCLE",
      message: "Downgrade agendado para o próximo ciclo.",
      subscription: buildSubscriptionPayload(currentSubscription, pendingChange),
      usage: buildUsageResponse(
        {
          code: currentSubscription.code,
          name: currentSubscription.name,
          max_audio_seconds: currentSubscription.max_audio_seconds,
          monthly_seconds: currentSubscription.monthly_seconds,
        },
        usageRow
      ),
    });
  } catch (err) {
    console.error("[POST /me/subscription/change] erro:", err);
    return res.status(500).json({
      error: "Erro ao alterar plano.",
      detail: err?.message || null,
    });
  }
});

router.post("/subscription/pending-change/cancel", authenticate, async (req, res) => {
  try {
    const userId = resolveUserId(req);

    if (userId == null) {
      return res.status(401).json({ error: "userId não encontrado no token." });
    }

    const pool = await getPool();

    const pendingChange = await getPendingSubscriptionChange(pool, userId);

    if (!pendingChange) {
      return res.status(400).json({
        error: "Nenhuma mudança agendada encontrada.",
      });
    }

    if (String(pendingChange.status || "").toUpperCase() !== "PENDING") {
      return res.status(400).json({
        error: "Mudança não pode ser cancelada.",
      });
    }

    await pool
      .request()
      .input("user_id", sql.BigInt, Number(userId))
      .query(`
        UPDATE dbo.user_subscription_change
        SET
            status = 'CANCELLED',
            cancelled_at = SYSUTCDATETIME()
        WHERE user_id = @user_id
          AND status = 'PENDING';
      `);

    const activeSubscription = await getActiveSubscription(pool, userId);
    const newPending = await getPendingSubscriptionChange(pool, userId);
    const usageRow = await getUsageSafe(
      pool,
      userId,
      activeSubscription
        ? {
            code: activeSubscription.code,
            name: activeSubscription.name,
            max_audio_seconds: activeSubscription.max_audio_seconds,
            monthly_seconds: activeSubscription.monthly_seconds,
          }
        : null
    );

    return res.json({
      ok: true,
      message: "Mudança agendada cancelada com sucesso.",
      subscription: buildSubscriptionPayload(activeSubscription, newPending),
      usage: buildUsageResponse(
        activeSubscription
          ? {
              code: activeSubscription.code,
              name: activeSubscription.name,
              max_audio_seconds: activeSubscription.max_audio_seconds,
              monthly_seconds: activeSubscription.monthly_seconds,
            }
          : null,
        usageRow
      ),
      pending_change: null,
    });
  } catch (err) {
    console.error("[POST /me/subscription/pending-change/cancel] erro:", err);
    return res.status(500).json({
      error: "Erro ao cancelar mudança agendada.",
      detail: err?.message || null,
    });
  }
});

export default router;