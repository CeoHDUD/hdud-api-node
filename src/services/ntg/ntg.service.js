import {
  getNarrativePath,
  listContextsByLifePeriod,
  listLifePeriods,
  listRolesByContext,
} from "./ntg.repository.js";
import { cached, getNtgCacheSettings } from "./ntg.cache.js";
import { normalizeCode, normalizeLocale, toNodeListDto } from "./ntg.dto.js";
import { NtgValidationError } from "./ntg.errors.js";

function requireCode(value, fieldName) {
  const code = normalizeCode(value);
  if (!code) {
    throw new NtgValidationError(
      `Parâmetro obrigatório ausente: ${fieldName}.`,
      { field: fieldName }
    );
  }
  if (!/^[A-Z0-9][A-Z0-9_-]{0,119}$/.test(code)) {
    throw new NtgValidationError(`Parâmetro inválido: ${fieldName}.`, {
      field: fieldName,
    });
  }
  return code;
}

function cacheKey(parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? ""))).join(":");
}

function metadata({ locale, cache, count }) {
  return {
    locale,
    count,
    cache,
    cache_policy: getNtgCacheSettings(),
  };
}

function firstRow(result) {
  return result?.rows?.[0] || result?.recordsets?.[0]?.[0] || null;
}

function directEdgeStep(row) {
  if (!row) return null;
  return {
    depth: Number(row.depth ?? 1),
    source_domain: row.source_domain ?? null,
    source_code: row.source_code ?? null,
    target_domain: row.target_domain ?? null,
    target_code: row.target_code ?? null,
    node_path: row.node_path ?? null,
    relation_path: row.relation_path ?? null,
    path_weight: row.path_weight == null ? null : Number(row.path_weight),
  };
}

function buildSelectionPath({
  lifePeriodCode,
  contextCode,
  narrativeRoleCode,
  db,
}) {
  const first = directEdgeStep(firstRow(db?.lifePeriodToContext));
  const second = directEdgeStep(firstRow(db?.contextToNarrativeRole));
  const found = Boolean(first && second);

  return {
    found,
    steps: found
      ? [
          {
            domain: "LIFE_PERIOD",
            code: lifePeriodCode,
          },
          {
            domain: "EDITORIAL_CONTEXT",
            code: contextCode,
          },
          {
            domain: "NARRATIVE_ROLE",
            code: narrativeRoleCode,
          },
        ]
      : [],
    edges: found
      ? [
          {
            source_domain: first.source_domain,
            source_code: first.source_code,
            target_domain: first.target_domain,
            target_code: first.target_code,
            relation_type: first.relation_path,
            weight: first.path_weight,
          },
          {
            source_domain: second.source_domain,
            source_code: second.source_code,
            target_domain: second.target_domain,
            target_code: second.target_code,
            relation_type: second.relation_path,
            weight: second.path_weight,
          },
        ]
      : [],
    validation: {
      life_period_to_context: Boolean(first),
      context_to_narrative_role: Boolean(second),
    },
  };
}

export async function getLifePeriods({ locale: localeInput = "pt-BR" } = {}) {
  const locale = normalizeLocale(localeInput);
  const result = await cached(cacheKey(["life-periods-v2", locale]), async () => {
    const db = await listLifePeriods({ locale });
    return toNodeListDto(db.rows, locale);
  });

  return {
    items: result.value,
    meta: metadata({ locale, cache: result.cache, count: result.value.length }),
  };
}

export async function getCompatibleContexts({
  lifePeriodCode: rawLifePeriodCode,
  locale: localeInput = "pt-BR",
}) {
  const locale = normalizeLocale(localeInput);
  const lifePeriodCode = requireCode(rawLifePeriodCode, "life_period_code");
  const result = await cached(
    cacheKey(["contexts-v2", locale, lifePeriodCode]),
    async () => {
      const db = await listContextsByLifePeriod({ lifePeriodCode, locale });
      return toNodeListDto(db.rows, locale);
    }
  );

  return {
    selection: { life_period_code: lifePeriodCode },
    items: result.value,
    meta: metadata({ locale, cache: result.cache, count: result.value.length }),
  };
}

export async function getCompatibleRoles({
  lifePeriodCode: rawLifePeriodCode,
  contextCode: rawContextCode,
  locale: localeInput = "pt-BR",
}) {
  const locale = normalizeLocale(localeInput);
  const lifePeriodCode = requireCode(rawLifePeriodCode, "life_period_code");
  const contextCode = requireCode(rawContextCode, "context_code");
  const result = await cached(
    cacheKey(["roles-v2", locale, lifePeriodCode, contextCode]),
    async () => {
      const db = await listRolesByContext({
        lifePeriodCode,
        contextCode,
        locale,
      });
      return toNodeListDto(db.rows, locale);
    }
  );

  return {
    selection: {
      life_period_code: lifePeriodCode,
      context_code: contextCode,
    },
    items: result.value,
    meta: metadata({ locale, cache: result.cache, count: result.value.length }),
  };
}

export async function getPath({
  lifePeriodCode: rawLifePeriodCode,
  contextCode: rawContextCode,
  narrativeRoleCode: rawNarrativeRoleCode,
  locale: localeInput = "pt-BR",
}) {
  const locale = normalizeLocale(localeInput);
  const lifePeriodCode = requireCode(rawLifePeriodCode, "life_period_code");
  const contextCode = requireCode(rawContextCode, "context_code");
  const narrativeRoleCode = requireCode(
    rawNarrativeRoleCode,
    "narrative_role_code"
  );

  const result = await cached(
    cacheKey([
      "selection-path-v2",
      locale,
      lifePeriodCode,
      contextCode,
      narrativeRoleCode,
    ]),
    async () => {
      const db = await getNarrativePath({
        lifePeriodCode,
        contextCode,
        narrativeRoleCode,
      });

      return buildSelectionPath({
        lifePeriodCode,
        contextCode,
        narrativeRoleCode,
        db,
      });
    }
  );

  return {
    selection: {
      life_period_code: lifePeriodCode,
      context_code: contextCode,
      narrative_role_code: narrativeRoleCode,
    },
    path: result.value,
    meta: metadata({
      locale,
      cache: result.cache,
      count: result.value.steps.length,
    }),
  };
}
