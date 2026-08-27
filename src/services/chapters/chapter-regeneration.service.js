// C:\HDUD_DATA\hdud-api-node\src\services\chapters\chapter-regeneration.service.js

import { getPool, sql } from "../../db.js";
import { generateEditorialChapter } from "./chapter-editorial.service.js";
import { persistAcceptedGenerationProvenance } from "./chapter-provenance-spans.service.js";

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanText(value, fallback = "") {
  if (value == null) return fallback;
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function oneLine(value, fallback = "") {
  return cleanText(value, fallback).replace(/\s+/g, " ").trim();
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function normalizeTheme(theme) {
  const s = oneLine(theme, "generic").toLowerCase();

  if (s === "school") return "school";
  if (s === "love") return "love";
  if (s === "health") return "health";
  if (s === "hdud") return "hdud";
  if (s === "work") return "work";

  return "generic";
}

function detectEditorialThemeFromMemories(memories) {
  const corpus = cleanText(
    memories.map((m) => `${m.title || ""}\n${m.content || ""}`).join("\n\n"),
    ""
  )
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (
    /\bescola\b|\bcolegio\b|\bestudar\b|\beducacao\b|\bserie\b|alfabetizacao|pinguinho de gente|maestro franklin/.test(
      corpus
    )
  ) {
    return "school";
  }

  if (/\bbruna\b|\blapa\b|\bnamoro\b|\bcasamento\b|\bamor\b|companheirismo/.test(corpus)) {
    return "love";
  }

  if (/cirurgia|hernia|hospital|dor|fisioterapia|internacao|recuperacao|l5|cervical/.test(corpus)) {
    return "health";
  }

  if (/\bhdud\b|historias de um desconhecido|startup|memorias|legado/.test(corpus)) {
    return "hdud";
  }

  if (/\bcbf\b|\breserva\b|\btrabalho\b|\bcarreira\b|\bbanco de dados\b|\bdba\b|sql server/.test(corpus)) {
    return "work";
  }

  return "generic";
}

async function assertChapterOwned(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        chapter_id,
        author_id,
        title,
        description,
        current_version_id,
        status,
        publication_status,
        published_version_number,
        published_at
      FROM dbo.identity_chapter
      WHERE chapter_id = @chapter_id
        AND author_id = @author_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  return result?.recordset?.[0] || null;
}

async function fetchLinkedMemoryIds(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT
        mc.memory_id,
        mc.sort_order,
        mc.created_at
      FROM dbo.identity_memory_chapter mc
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = mc.memory_id
       AND m.author_id = mc.author_id
      WHERE mc.author_id = @author_id
        AND mc.chapter_id = @chapter_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY
        CASE WHEN mc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
        mc.sort_order ASC,
        mc.created_at ASC,
        mc.memory_id ASC;
    `);

  return (result?.recordset || [])
    .map((r) => toPositiveInt(r.memory_id))
    .filter(Boolean);
}

async function fetchLinkedMemoriesForProfile(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      ;WITH latest_version AS (
        SELECT
          mv.memory_id,
          mv.title AS version_title,
          mv.content AS version_content,
          ROW_NUMBER() OVER (
            PARTITION BY mv.memory_id
            ORDER BY mv.version_number DESC, mv.version_id DESC
          ) AS rn
        FROM dbo.identity_memory_versions mv
      )
      SELECT
        m.memory_id,
        COALESCE(NULLIF(LTRIM(RTRIM(lv.version_title)), ''), m.title) AS title,
        COALESCE(NULLIF(LTRIM(RTRIM(lv.version_content)), ''), m.content) AS content,
        m.created_at,
        m.published_at,
        m.phase_id,
        p.phase_code,
        p.name AS phase_name,
        mc.sort_order
      FROM dbo.identity_memory_chapter mc
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = mc.memory_id
       AND m.author_id = mc.author_id
      LEFT JOIN latest_version lv
        ON lv.memory_id = m.memory_id
       AND lv.rn = 1
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE mc.author_id = @author_id
        AND mc.chapter_id = @chapter_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY
        CASE WHEN mc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
        mc.sort_order ASC,
        mc.created_at ASC,
        mc.memory_id ASC;
    `);

  return (result?.recordset || []).map((r) => ({
    memory_id: Number(r.memory_id),
    title: r.title ?? null,
    content: r.content ?? null,
    created_at: r.created_at ?? null,
    published_at: r.published_at ?? null,
    phase_id: r.phase_id ?? null,
    phase_code: r.phase_code ?? null,
    phase_name: r.phase_name ?? null,
  }));
}

async function getLatestVersionId(pool, chapterId) {
  const result = await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 chapter_version_id
      FROM dbo.identity_chapter_versions
      WHERE chapter_id = @chapter_id
      ORDER BY chapter_version_id DESC;
    `);

  return toPositiveInt(result?.recordset?.[0]?.chapter_version_id);
}

async function insertChapterEvolution(pool, payload) {
  await pool
    .request()
    .input("author_id", sql.Int, payload.author_id)
    .input("chapter_id", sql.Int, payload.chapter_id)
    .input("event_type", sql.VarChar(50), payload.event_type)
    .input("source_version_id", sql.Int, payload.source_version_id ?? null)
    .input("target_version_id", sql.Int, payload.target_version_id ?? null)
    .input("memory_id", sql.Int, payload.memory_id ?? null)
    .input("metadata_json", sql.NVarChar(sql.MAX), safeJson(payload.metadata))
    .query(`
      INSERT INTO dbo.identity_chapter_evolution
      (
        author_id,
        chapter_id,
        event_type,
        source_version_id,
        target_version_id,
        memory_id,
        metadata_json,
        created_at
      )
      VALUES
      (
        @author_id,
        @chapter_id,
        @event_type,
        @source_version_id,
        @target_version_id,
        @memory_id,
        @metadata_json,
        SYSUTCDATETIME()
      );
    `);
}

async function upsertEditorialProfile(pool, chapterId, memories) {
  const theme = normalizeTheme(detectEditorialThemeFromMemories(memories));
  const memoryCount = memories.length;

  const phaseCounts = new Map();
  for (const memory of memories) {
    const phase = oneLine(memory.phase_name || memory.phase_code || "", "");
    if (!phase) continue;
    phaseCounts.set(phase, (phaseCounts.get(phase) || 0) + 1);
  }

  const lifePhase =
    [...phaseCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const dated = memories
    .map((m) => m.published_at || m.created_at || null)
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => Number.isFinite(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const periodStart = dated[0] ? dated[0].toISOString().slice(0, 10) : null;
  const periodEnd = dated[dated.length - 1]
    ? dated[dated.length - 1].toISOString().slice(0, 10)
    : null;

  const confidenceScore =
    memoryCount >= 5 ? 0.95 : memoryCount >= 3 ? 0.88 : memoryCount >= 2 ? 0.76 : 0.6;

  const factualScore = 1.0;

  await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .input("theme", sql.VarChar(50), theme)
    .input("life_phase", sql.VarChar(100), lifePhase)
    .input("period_start", sql.Date, periodStart)
    .input("period_end", sql.Date, periodEnd)
    .input("memory_count", sql.Int, memoryCount)
    .input("confidence_score", sql.Decimal(5, 2), confidenceScore)
    .input("factual_score", sql.Decimal(5, 2), factualScore)
    .query(`
      MERGE dbo.identity_chapter_editorial_profile AS target
      USING (
        SELECT
          @chapter_id AS chapter_id,
          @theme AS theme,
          @life_phase AS life_phase,
          @period_start AS period_start,
          @period_end AS period_end,
          @memory_count AS memory_count,
          @confidence_score AS confidence_score,
          @factual_score AS factual_score
      ) AS source
      ON target.chapter_id = source.chapter_id
      WHEN MATCHED THEN
        UPDATE SET
          theme = source.theme,
          life_phase = source.life_phase,
          period_start = source.period_start,
          period_end = source.period_end,
          memory_count = source.memory_count,
          confidence_score = source.confidence_score,
          factual_score = source.factual_score,
          updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT
        (
          chapter_id,
          theme,
          life_phase,
          period_start,
          period_end,
          memory_count,
          confidence_score,
          factual_score,
          updated_at
        )
        VALUES
        (
          source.chapter_id,
          source.theme,
          source.life_phase,
          source.period_start,
          source.period_end,
          source.memory_count,
          source.confidence_score,
          source.factual_score,
          SYSUTCDATETIME()
        );
    `);

  return {
    theme,
    life_phase: lifePhase,
    period_start: periodStart,
    period_end: periodEnd,
    memory_count: memoryCount,
    confidence_score: confidenceScore,
    factual_score: factualScore,
  };
}

export async function regenerateChapter({ userId = null, authorId, chapterId, title = null, proposalOnly = false }) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeChapterId = toPositiveInt(chapterId);

  if (!safeAuthorId) {
    const err = new Error("author_id inválido.");
    err.statusCode = 401;
    throw err;
  }

  if (!safeChapterId) {
    const err = new Error("chapter_id inválido.");
    err.statusCode = 400;
    throw err;
  }

  const pool = await getPool();

  const chapter = await assertChapterOwned(pool, safeAuthorId, safeChapterId);
  if (!chapter) {
    const err = new Error("Capítulo não encontrado.");
    err.statusCode = 404;
    throw err;
  }

  const sourceVersionId = await getLatestVersionId(pool, safeChapterId);
  const memoryIds = await fetchLinkedMemoryIds(pool, safeAuthorId, safeChapterId);

  if (memoryIds.length < 1) {
    const err = new Error("Capítulo sem memórias vinculadas para regeneração.");
    err.statusCode = 422;
    err.code = "CHAPTER_WITHOUT_MEMORIES";
    throw err;
  }

  const explicitTitle = oneLine(title, "") || oneLine(chapter.title, null);

  const generation = await generateEditorialChapter({
    userId,
    authorId: safeAuthorId,
    memoryIds,
    title: explicitTitle,
  });

  const nextTitle = oneLine(generation.generated_title, chapter.title);
  const nextDescription = oneLine(generation.generated_description, chapter.description || "");
  const nextContent = cleanText(generation.generated_content, "");

  if (!nextTitle || !nextContent) {
    const err = new Error("Regeneração retornou resultado incompleto.");
    err.statusCode = 500;
    err.code = "INVALID_REGENERATION_RESULT";
    throw err;
  }

  // Contrato editorial: qualquer capítulo que já possua versão corrente NUNCA é
  // alterado pelo simples ato de regenerar. A IA produz uma proposta auditável; somente
  // a aceitação explícita do autor pode criar a próxima identity_chapter_version.
  //
  // proposalOnly continua aceito por compatibilidade com os chamadores, mas a decisão
  // também é protegida aqui no domínio para que um erro/versão antiga da rota não consiga
  // consolidar silenciosamente uma regeneração sobre um capítulo existente.
  const mustReturnProposal = proposalOnly || !!toPositiveInt(chapter.current_version_id);

  if (mustReturnProposal) {
    // A geração já aconteceu e deve continuar auditável/contabilizada. Vinculamos apenas
    // o capítulo à geração; chapter_version_id permanece NULL até "Aceitar proposta".
    if (generation.generation_id) {
      await pool
        .request()
        .input("author_id", sql.Int, safeAuthorId)
        .input("generation_id", sql.BigInt, generation.generation_id)
        .input("chapter_id", sql.Int, safeChapterId)
        .query(`
          UPDATE dbo.identity_chapter_generation
          SET chapter_id = @chapter_id
          WHERE generation_id = @generation_id
            AND author_id = @author_id
            AND chapter_version_id IS NULL;
        `);
    }

    return {
      ok: true,
      regenerated: false,
      proposal: true,
      chapter_id: safeChapterId,
      generation_id: generation.generation_id ?? null,
      source_version_id: sourceVersionId,
      title: nextTitle,
      description: nextDescription,
      body: nextContent,
      source_memory_ids: memoryIds,
      source_memory_count: memoryIds.length,
      meta: {
        generation_id: generation.generation_id ?? null,
        provider: generation?.meta?.provider ?? null,
        model: generation?.meta?.model ?? null,
        prompt_version: generation?.meta?.prompt_version ?? null,
        generated_at: generation?.meta?.generated_at ?? null,
      },
    };
  }

  const updateResult = await pool
    .request()
    .input("author_id", sql.Int, safeAuthorId)
    .input("chapter_id", sql.Int, safeChapterId)
    .input("title", sql.NVarChar(200), nextTitle)
    .input("description", sql.NVarChar(400), nextDescription)
    .input("body", sql.NVarChar(sql.MAX), nextContent)
    .output("chapter_version_id", sql.Int)
    .execute("dbo.p_Chapter_Update_WithVersion");

  const targetVersionId =
    toPositiveInt(updateResult?.output?.chapter_version_id) ||
    toPositiveInt(updateResult?.recordset?.[0]?.chapter_version_id) ||
    (await getLatestVersionId(pool, safeChapterId));

  // GAP #14: fecha a cadeia auditável geração -> capítulo -> versão -> ledger IA.
  if (generation.generation_id && targetVersionId) {
    await pool
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("generation_id", sql.BigInt, generation.generation_id)
      .input("chapter_id", sql.Int, safeChapterId)
      .input("chapter_version_id", sql.Int, targetVersionId)
      .query(`
        UPDATE dbo.identity_chapter_generation
        SET
          chapter_id = @chapter_id,
          chapter_version_id = @chapter_version_id
        WHERE generation_id = @generation_id
          AND author_id = @author_id;
      `);
  }

  // GAP #16 — no nascimento da versão regenerada, congela a origem de cada trecho.
  // Se o autor ajustou a proposta antes da aceitação, somente os trechos novos ficam AUTHOR_EDIT.
  let granularProvenancePersisted = false;
  if (generation.generation_id && targetVersionId) {
    try {
      const persisted = await persistAcceptedGenerationProvenance(pool, {
        authorId: safeAuthorId,
        chapterId: safeChapterId,
        chapterVersionId: targetVersionId,
        generationId: generation.generation_id,
        acceptedText: nextContent,
      });
      granularProvenancePersisted = persisted.length > 0;
    } catch (error) {
      console.warn("Chapter granular provenance persist failed:", error?.message);
    }
  }

  // Capítulo já publicado continua publicado na nova versão regenerada.
  // A regeneração é uma nova versão editorial; não deve deixar Feed/Livro/Preview
  // presos na versão anterior.
  const wasPublic = ["PUBLIC", "PUBLISHED", "SHARED"].includes(
    oneLine(chapter.publication_status || chapter.status, "").toUpperCase()
  );

  if (wasPublic && targetVersionId) {
    await pool
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("chapter_id", sql.Int, safeChapterId)
      .input("chapter_version_id", sql.Int, targetVersionId)
      .query(`
        UPDATE dbo.identity_chapter
        SET
          status = 'PUBLIC',
          publication_status = 'PUBLIC',
          published_version_number = @chapter_version_id,
          published_at = COALESCE(published_at, SYSUTCDATETIME()),
          updated_at = SYSUTCDATETIME()
        WHERE chapter_id = @chapter_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;
      `);
  }

  const memoriesForProfile = await fetchLinkedMemoriesForProfile(
    pool,
    safeAuthorId,
    safeChapterId
  );

  const editorialProfile = await upsertEditorialProfile(
    pool,
    safeChapterId,
    memoriesForProfile
  );

  await insertChapterEvolution(pool, {
    author_id: safeAuthorId,
    chapter_id: safeChapterId,
    event_type: "CHAPTER_REGENERATED",
    source_version_id: sourceVersionId,
    target_version_id: targetVersionId,
    memory_id: null,
    metadata: {
      source: "chapter-regeneration.service",
      generation_id: generation.generation_id ?? null,
      generation_type: generation.generation_type ?? "EDITORIAL",
      source_memory_ids: memoryIds,
      source_memory_count: memoryIds.length,
      provider: generation?.meta?.provider ?? null,
      model: generation?.meta?.model ?? null,
      prompt_version: generation?.meta?.prompt_version ?? null,
      rules: generation?.meta?.rules ?? [],
      provenance_granularity: granularProvenancePersisted ? "PERSISTED_SEGMENTS_V1" : "DEFERRED_BACKFILL",
    },
  });

  return {
    ok: true,
    regenerated: true,
    chapter_id: safeChapterId,
    chapter_version_id: targetVersionId,
    source_version_id: sourceVersionId,
    target_version_id: targetVersionId,
    title: nextTitle,
    description: nextDescription,
    body: nextContent,
    source_memory_ids: memoryIds,
    source_memory_count: memoryIds.length,
    editorial_profile: editorialProfile,
    publication_status: wasPublic ? "PUBLIC" : oneLine(chapter.publication_status || chapter.status, "DRAFT").toUpperCase(),
    published_version_number: wasPublic ? targetVersionId : (toPositiveInt(chapter.published_version_number) || null),
    publication_auto_synced: wasPublic,
    meta: {
      generation_id: generation.generation_id ?? null,
      provider: generation?.meta?.provider ?? null,
      model: generation?.meta?.model ?? null,
      prompt_version: generation?.meta?.prompt_version ?? null,
      generated_at: generation?.meta?.generated_at ?? null,
    },
  };
}


export async function acceptChapterRegeneration({ authorId, chapterId, generationId, sourceVersionId, title, description = null, body }) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeChapterId = toPositiveInt(chapterId);
  const safeGenerationId = toPositiveInt(generationId);
  const safeSourceVersionId = toPositiveInt(sourceVersionId);
  if (!safeAuthorId || !safeChapterId || !safeGenerationId || !safeSourceVersionId) {
    const err = new Error("Proposta de regeneração inválida."); err.statusCode = 400; throw err;
  }
  const nextTitle = oneLine(title, "");
  const nextDescription = oneLine(description, "");
  const nextContent = cleanText(body, "");
  if (!nextTitle || !nextContent) { const err = new Error("Proposta incompleta."); err.statusCode = 400; throw err; }

  const pool = await getPool();
  const chapter = await assertChapterOwned(pool, safeAuthorId, safeChapterId);
  if (!chapter) { const err = new Error("Capítulo não encontrado."); err.statusCode = 404; throw err; }
  if (toPositiveInt(chapter.current_version_id) !== safeSourceVersionId) {
    const err = new Error("O capítulo mudou depois que a proposta foi gerada. Gere uma nova proposta.");
    err.statusCode = 409; err.code = "STALE_REGENERATION_PROPOSAL"; throw err;
  }

  const generationCheck = await pool.request()
    .input("author_id", sql.Int, safeAuthorId)
    .input("generation_id", sql.BigInt, safeGenerationId)
    .query(`SELECT TOP 1 generation_id, chapter_id, chapter_version_id FROM dbo.identity_chapter_generation WHERE generation_id=@generation_id AND author_id=@author_id;`);
  const generationRow = generationCheck?.recordset?.[0];
  if (!generationRow) { const err = new Error("Geração não encontrada."); err.statusCode = 404; throw err; }
  if (toPositiveInt(generationRow.chapter_version_id)) { const err = new Error("Esta proposta já foi consolidada."); err.statusCode = 409; throw err; }

  const updateResult = await pool.request()
    .input("author_id", sql.Int, safeAuthorId).input("chapter_id", sql.Int, safeChapterId)
    .input("title", sql.NVarChar(200), nextTitle).input("description", sql.NVarChar(400), nextDescription)
    .input("body", sql.NVarChar(sql.MAX), nextContent).output("chapter_version_id", sql.Int)
    .execute("dbo.p_Chapter_Update_WithVersion");
  const targetVersionId = toPositiveInt(updateResult?.output?.chapter_version_id) || toPositiveInt(updateResult?.recordset?.[0]?.chapter_version_id) || await getLatestVersionId(pool, safeChapterId);

  await pool.request().input("author_id", sql.Int, safeAuthorId).input("generation_id", sql.BigInt, safeGenerationId)
    .input("chapter_id", sql.Int, safeChapterId).input("chapter_version_id", sql.Int, targetVersionId)
    .query(`UPDATE dbo.identity_chapter_generation SET chapter_id=@chapter_id, chapter_version_id=@chapter_version_id WHERE generation_id=@generation_id AND author_id=@author_id;`);

  const wasPublic = ["PUBLIC","PUBLISHED","SHARED"].includes(oneLine(chapter.publication_status || chapter.status, "").toUpperCase());
  if (wasPublic) await pool.request().input("author_id",sql.Int,safeAuthorId).input("chapter_id",sql.Int,safeChapterId).input("chapter_version_id",sql.Int,targetVersionId)
    .query(`UPDATE dbo.identity_chapter SET status='PUBLIC', publication_status='PUBLIC', published_version_number=@chapter_version_id, published_at=COALESCE(published_at,SYSUTCDATETIME()), updated_at=SYSUTCDATETIME() WHERE chapter_id=@chapter_id AND author_id=@author_id AND ISNULL(is_deleted,0)=0;`);

  let granularProvenancePersisted = false;
  try {
    const persisted = await persistAcceptedGenerationProvenance(pool, {
      authorId: safeAuthorId,
      chapterId: safeChapterId,
      chapterVersionId: targetVersionId,
      generationId: safeGenerationId,
      acceptedText: nextContent,
    });
    granularProvenancePersisted = persisted.length > 0;
  } catch (error) {
    console.warn("Chapter granular provenance accept persist failed:", error?.message);
  }

  await insertChapterEvolution(pool,{author_id:safeAuthorId,chapter_id:safeChapterId,event_type:"CHAPTER_REGENERATION_ACCEPTED",source_version_id:safeSourceVersionId,target_version_id:targetVersionId,memory_id:null,metadata:{source:"chapter-regeneration.service",generation_id:safeGenerationId,provenance_granularity:granularProvenancePersisted?"PERSISTED_SEGMENTS_V1":"DEFERRED_BACKFILL"}});
  return {ok:true,accepted:true,chapter_id:safeChapterId,generation_id:safeGenerationId,source_version_id:safeSourceVersionId,target_version_id:targetVersionId,chapter_version_id:targetVersionId,provenance_granularity:granularProvenancePersisted?"PERSISTED_SEGMENTS_V1":"DEFERRED_BACKFILL"};
}

export async function discardChapterRegeneration({ authorId, chapterId, generationId, sourceVersionId }) {
  const safeAuthorId=toPositiveInt(authorId), safeChapterId=toPositiveInt(chapterId), safeGenerationId=toPositiveInt(generationId), safeSourceVersionId=toPositiveInt(sourceVersionId);
  if(!safeAuthorId||!safeChapterId||!safeGenerationId||!safeSourceVersionId){const err=new Error("Proposta de regeneração inválida.");err.statusCode=400;throw err;}
  const pool=await getPool();
  const chapter=await assertChapterOwned(pool,safeAuthorId,safeChapterId);
  if(!chapter){const err=new Error("Capítulo não encontrado.");err.statusCode=404;throw err;}
  const generationCheck=await pool.request().input("author_id",sql.Int,safeAuthorId).input("generation_id",sql.BigInt,safeGenerationId)
    .query(`SELECT TOP 1 generation_id, chapter_version_id FROM dbo.identity_chapter_generation WHERE generation_id=@generation_id AND author_id=@author_id;`);
  if(!generationCheck?.recordset?.[0]){const err=new Error("Geração não encontrada.");err.statusCode=404;throw err;}
  if(toPositiveInt(generationCheck.recordset[0].chapter_version_id)){const err=new Error("Esta proposta já foi consolidada.");err.statusCode=409;throw err;}
  await insertChapterEvolution(pool,{author_id:safeAuthorId,chapter_id:safeChapterId,event_type:"CHAPTER_REGENERATION_DISCARDED",source_version_id:safeSourceVersionId,target_version_id:null,memory_id:null,metadata:{source:"chapter-regeneration.service",generation_id:safeGenerationId}});
  return {ok:true,discarded:true,chapter_id:safeChapterId,generation_id:safeGenerationId,current_version_id:toPositiveInt(chapter.current_version_id)};
}
