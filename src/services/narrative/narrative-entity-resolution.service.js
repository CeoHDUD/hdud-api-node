// C:\HDUD_DATA\hdud-api-node\src\services\narrative\narrative-entity-resolution.service.js

import { getPool, sql } from "../../db.js";

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;

  const text = String(value).trim();

  return text.length
    ? text
    : fallback;
}

function normalizeKey(value) {
  return normalizeText(value, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function buildAliasCandidates(entityName) {
  const aliases = new Set();

  const normalized =
    normalizeText(entityName, "");

  if (!normalized) {
    return [];
  }

  aliases.add(normalized);

  const parts =
    normalized.split(" ");

  // Primeiro nome
  if (parts.length > 1) {
    aliases.add(parts[0]);
  }

  // Nome sem sobrenome
  if (parts.length > 2) {
    aliases.add(
      parts.slice(0, 2).join(" ")
    );
  }

  return [...aliases];
}

function calculateConfidenceScore({
  sourceName,
  targetName,
}) {
  const a = normalizeKey(sourceName);
  const b = normalizeKey(targetName);

  if (!a || !b) return 0;

  if (a === b) return 10;

  if (
    a.includes(b) ||
    b.includes(a)
  ) {
    return 9;
  }

  const aParts =
    a.split(" ");

  const bParts =
    b.split(" ");

  const overlap =
    aParts.filter((p) =>
      bParts.includes(p)
    ).length;

  if (overlap >= 2) {
    return 8;
  }

  if (overlap === 1) {
    return 6;
  }

  return 0;
}

async function createAliasIfMissing({
  pool,
  entityId,
  aliasName,
  confidenceScore = 5,
  sourceType = "AUTO",
}) {
  if (!aliasName) return;

  await pool
    .request()
    .input(
      "entity_id",
      sql.BigInt,
      entityId
    )
    .input(
      "alias_name",
      sql.NVarChar(255),
      aliasName
    )
    .input(
      "confidence_score",
      sql.Int,
      confidenceScore
    )
    .input(
      "source_type",
      sql.VarChar(50),
      sourceType
    )
    .query(`
      IF NOT EXISTS
      (
        SELECT 1
        FROM dbo.identity_narrative_entity_alias
        WHERE entity_id = @entity_id
          AND alias_name = @alias_name
      )
      BEGIN
        INSERT INTO dbo.identity_narrative_entity_alias
        (
          entity_id,
          alias_name,
          confidence_score,
          source_type
        )
        VALUES
        (
          @entity_id,
          @alias_name,
          @confidence_score,
          @source_type
        );
      END
    `);
}

export async function resolveNarrativeEntity({
  authorId,
  entityType,
  entityName,
}) {

  const normalizedName =
    normalizeText(entityName, "");

  if (!normalizedName) {
    return {
      ok: false,
      reason:
        "entity_name inválido.",
    };
  }

  const pool =
    await getPool();

  // =========================================
  // EXACT MATCH
  // =========================================

  const exactResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .input(
        "entity_type",
        sql.VarChar(50),
        entityType
      )
      .input(
        "entity_name",
        sql.NVarChar(255),
        normalizedName
      )
      .query(`
        SELECT TOP 1
          entity_id,
          entity_name,
          recurrence_count,
          importance_score
        FROM dbo.identity_narrative_entity
        WHERE author_id = @author_id
          AND entity_type = @entity_type
          AND entity_name = @entity_name
      `);

  const exactEntity =
    exactResult.recordset?.[0];

  if (exactEntity) {

    const aliases =
      buildAliasCandidates(
        normalizedName
      );

    for (const alias of aliases) {
      await createAliasIfMissing({
        pool,
        entityId:
          exactEntity.entity_id,
        aliasName: alias,
        confidenceScore: 10,
        sourceType:
          "AUTO_EXACT",
      });
    }

    return {
      ok: true,
      resolution_mode:
        "EXACT_MATCH",

      entity: {
        entity_id:
          Number(
            exactEntity.entity_id
          ),

        canonical_name:
          exactEntity.entity_name,

        recurrence_count:
          exactEntity
            .recurrence_count,

        importance_score:
          exactEntity
            .importance_score,
      },
    };
  }

  // =========================================
  // ALIAS MATCH
  // =========================================

  const aliasResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .input(
        "entity_type",
        sql.VarChar(50),
        entityType
      )
      .query(`
        SELECT
          e.entity_id,
          e.entity_name,
          a.alias_name,
          a.confidence_score
        FROM dbo.identity_narrative_entity e
        INNER JOIN dbo.identity_narrative_entity_alias a
          ON a.entity_id = e.entity_id
        WHERE e.author_id = @author_id
          AND e.entity_type = @entity_type
      `);

  const aliases =
    aliasResult.recordset || [];

  let bestMatch = null;
  let bestScore = 0;

  for (const alias of aliases) {

    const score =
      calculateConfidenceScore({
        sourceName:
          normalizedName,

        targetName:
          alias.alias_name,
      });

    if (score > bestScore) {
      bestScore = score;
      bestMatch = alias;
    }
  }

  if (
    bestMatch &&
    bestScore >= 8
  ) {

    await createAliasIfMissing({
      pool,
      entityId:
        bestMatch.entity_id,

      aliasName:
        normalizedName,

      confidenceScore:
        bestScore,

      sourceType:
        "AUTO_ALIAS",
    });

    return {
      ok: true,

      resolution_mode:
        "ALIAS_MATCH",

      confidence_score:
        bestScore,

      entity: {
        entity_id:
          Number(
            bestMatch.entity_id
          ),

        canonical_name:
          bestMatch.entity_name,
      },
    };
  }

  // =========================================
  // NO MATCH
  // =========================================

  return {
    ok: true,

    resolution_mode:
      "NO_MATCH",

    entity: null,
  };
}