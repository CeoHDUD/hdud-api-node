import express from "express";
import { authenticate } from "../middleware/auth.js";
import {
  getCompatibleContexts,
  getCompatibleRoles,
  getLifePeriods,
  getPath,
} from "../services/ntg/ntg.service.js";
import { toNtgHttpError } from "../services/ntg/ntg.errors.js";

const router = express.Router();

function localeFrom(req) {
  return req.query?.locale || req.query?.language || "pt-BR";
}

function sendSuccess(res, payload, aliases = {}) {
  return res.json({
    ok: true,
    data: payload,
    ...aliases,
    meta: payload.meta,
  });
}

function sendError(res, err) {
  const normalized = toNtgHttpError(err);
  return res.status(normalized.status).json({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details || null,
    },
  });
}

router.get("/life-periods", authenticate, async (req, res) => {
  try {
    const payload = await getLifePeriods({ locale: localeFrom(req) });
    return sendSuccess(res, payload, {
      items: payload.items,
      life_periods: payload.items,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get("/contexts", authenticate, async (req, res) => {
  try {
    const payload = await getCompatibleContexts({
      lifePeriodCode: req.query?.life_period_code,
      locale: localeFrom(req),
    });
    return sendSuccess(res, payload, {
      items: payload.items,
      contexts: payload.items,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get("/roles", authenticate, async (req, res) => {
  try {
    const payload = await getCompatibleRoles({
      lifePeriodCode: req.query?.life_period_code,
      contextCode: req.query?.context_code,
      locale: localeFrom(req),
    });
    return sendSuccess(res, payload, {
      items: payload.items,
      roles: payload.items,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get("/path", authenticate, async (req, res) => {
  try {
    const payload = await getPath({
      lifePeriodCode: req.query?.life_period_code,
      contextCode: req.query?.context_code,
      narrativeRoleCode: req.query?.narrative_role_code,
      locale: localeFrom(req),
    });
    return sendSuccess(res, payload, {
      path: payload.path,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
