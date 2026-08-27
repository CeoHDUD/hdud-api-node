import { getPool, sql } from "../../db.js";
import { NtgDataAccessError } from "./ntg.errors.js";

async function executeProcedure(name, bindInputs) {
  try {
    const pool = await getPool();
    const request = pool.request();

    bindInputs(request);

    const result = await request.execute(`dbo.${name}`);

    return {
      rows: result.recordset || [],
      recordsets:
        result.recordsets ||
        (result.recordset ? [result.recordset] : []),
      rowsAffected: result.rowsAffected || [],
      output: result.output || {},
    };
  } catch (err) {
    console.error(`[NTG][REPOSITORY] ${name} failed:`, {
      message: err?.message || String(err),
      number: err?.number ?? null,
      code: err?.code ?? null,
      state: err?.state ?? null,
      procedure: err?.procName ?? null,
      line: err?.lineNumber ?? null,
    });

    throw new NtgDataAccessError(
      `Não foi possível executar dbo.${name}.`,
      err
    );
  }
}

export function listLifePeriods({ locale }) {
  return executeProcedure("p_MeiTaxonomy_List", (request) => {
    request.input("locale", sql.VarChar(20), locale);
    request.input("domain", sql.VarChar(60), "LIFE_PERIOD");
  });
}

export function listContextsByLifePeriod({
  lifePeriodCode,
  locale,
}) {
  return executeProcedure(
    "p_MeiTaxonomy_ContextsByLifePeriod",
    (request) => {
      request.input(
        "life_period_code",
        sql.VarChar(120),
        lifePeriodCode
      );

      request.input(
        "locale",
        sql.VarChar(20),
        locale
      );
    }
  );
}

export function listRolesByContext({
  lifePeriodCode,
  contextCode,
  locale,
}) {
  return executeProcedure(
    "p_MeiTaxonomy_RolesByContext",
    (request) => {
      request.input(
        "life_period_code",
        sql.VarChar(120),
        lifePeriodCode
      );

      request.input(
        "context_code",
        sql.VarChar(120),
        contextCode
      );

      request.input(
        "locale",
        sql.VarChar(20),
        locale
      );
    }
  );
}

function getDirectPath({
  sourceDomain,
  sourceCode,
  targetDomain,
  targetCode,
}) {
  return executeProcedure("p_MeiTaxonomy_Path", (request) => {
    request.input("source_domain", sql.VarChar(60), sourceDomain);
    request.input("source_code", sql.VarChar(120), sourceCode);
    request.input("target_domain", sql.VarChar(60), targetDomain);
    request.input("target_code", sql.VarChar(120), targetCode);
    request.input("relation_type", sql.VarChar(60), null);
    request.input("max_depth", sql.Int, 1);
  });
}

export async function getNarrativePath({
  lifePeriodCode,
  contextCode,
  narrativeRoleCode,
}) {
  const [lifePeriodToContext, contextToNarrativeRole] = await Promise.all([
    getDirectPath({
      sourceDomain: "LIFE_PERIOD",
      sourceCode: lifePeriodCode,
      targetDomain: "EDITORIAL_CONTEXT",
      targetCode: contextCode,
    }),
    getDirectPath({
      sourceDomain: "EDITORIAL_CONTEXT",
      sourceCode: contextCode,
      targetDomain: "NARRATIVE_ROLE",
      targetCode: narrativeRoleCode,
    }),
  ]);

  return {
    lifePeriodToContext,
    contextToNarrativeRole,
  };
}
