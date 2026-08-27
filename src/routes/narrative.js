// C:\HDUD_DATA\hdud-api-node\src\routes\narrative.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { generateNarrativeChapterWithOpenAI } from "../services/narrative/openai-narrative.service.js";
import { refineMemoryWithOpenAI } from "../services/narrative/memory-refiner.service.js";
import { generateVoiceProfile } from "../services/narrative/voice-profile.service.js";
import { extractNarrativeEntities } from "../services/narrative/entity-extraction.service.js";
import { extractTimelineEvents } from "../services/narrative/timeline-extraction.service.js";
import { extractNarrativeRelationships } from "../services/narrative/relationship-extraction.service.js";
import { resolveNarrativeEntity } from "../services/narrative/narrative-entity-resolution.service.js";
import { getRelationshipEvolution, listRelationshipEvolutions } from "../services/narrative/relationship-evolution.service.js";
import { buildEmotionalClusters } from "../services/narrative/emotional-cluster.service.js";
import { buildNarrativeArcs } from "../services/narrative/narrative-arc.service.js";
import { loadAuthorNarrativeContext, } from "../services/narrative/narrative-orchestrator.service.js";
import { recallConnectedMemories } from "../services/narrative/memory-recall.service.js";
import { buildAutobiographicalCognition } from "../services/narrative/autobiographical-cognition.service.js";
import { orchestrateNarrativeChapter } from "../services/narrative/chapter-orchestrator.service.js";
import { buildSymbolicRecurrence } from "../services/narrative/symbolic-recurrence.service.js";
import { buildMemoryResonance } from "../services/narrative/memory-resonance.service.js";
import { buildNarrativeContinuity } from "../services/narrative/narrative-continuity.service.js";
import { buildAuthorCognitiveProfile } from "../services/narrative/author-cognitive-profile.service.js";
import { orchestrateAutobiographicalBook } from "../services/narrative/book-orchestrator.service.js";
import { orchestrateLifeTimeline } from "../services/narrative/life-timeline-orchestrator.service.js";
import { buildLifeEventSignificance } from "../services/narrative/life-event-significance.service.js";

const router = express.Router();

function getAuthorId(req) {
  const authorId = Number(req.user?.author_id);
  return Number.isInteger(authorId) && authorId > 0 ? authorId : null;
}

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text.length ? text : fallback;
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function makePreview(text, maxLen = 220) {
  const clean = normalizeText(text, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}â€¦` : clean;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeMemoryIds(value) {
  if (!Array.isArray(value)) return [];

  const ids = value
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);

  return [...new Set(ids)].slice(0, 50);
}

function normalizeProfileText(value, maxLen = 100) {
  if (value == null) return null;

  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.join("; ")
        : JSON.stringify(value);

  const clean = String(text || "").trim();
  if (!clean) return null;

  return clean.slice(0, maxLen);
}

function normalizeProfileInt(value, min = 0, max = 10) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeProfileObservations(value) {
  if (value == null) return "[]";

  if (Array.isArray(value)) {
    return JSON.stringify(value.map((x) => String(x || "").trim()).filter(Boolean));
  }

  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean) return "[]";

    try {
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch {}

    return JSON.stringify([clean]);
  }

  return JSON.stringify([JSON.stringify(value)]);
}

function parseVoiceProfileObservations(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean) return [];

    try {
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [clean];
    }
  }

  return [];
}

async function loadLatestVoiceProfile(pool, authorId) {
  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .query(`
      SELECT TOP 1
        voice_profile_id,
        writing_style,
        emotional_tone,
        narrative_density,
        sentence_length_avg,
        emotional_intensity,
        preferred_language,
        ai_observations,
        sample_size_memories,
        created_at,
        updated_at
      FROM dbo.identity_author_voice_profile
      WHERE author_id = @author_id
      ORDER BY
        created_at DESC,
        voice_profile_id DESC;
    `);

  const row = result.recordset?.[0] || null;
  if (!row) return null;

  return {
    voice_profile_id: Number(row.voice_profile_id),
    writing_style: row.writing_style || null,
    emotional_tone: row.emotional_tone || null,
    narrative_density: row.narrative_density ?? null,
    sentence_length_avg: row.sentence_length_avg ?? null,
    emotional_intensity: row.emotional_intensity ?? null,
    preferred_language: row.preferred_language || null,
    ai_observations: parseVoiceProfileObservations(row.ai_observations),
    sample_size_memories: row.sample_size_memories ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeNarrativeEntityName(value) {
  const name = normalizeText(value, "");

  if (!name) return "";

  const key = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

  const selfAliases = new Set([
    "EU",
    "MIM",
    "ME",
    "COMIGO",
    "NARRADOR",
    "NARRADORA",
    "AUTOR",
    "AUTORA",
    "O NARRADOR",
    "A NARRADORA",
    "O AUTOR",
    "A AUTORA",
    "O PROPRIO AUTOR",
    "A PROPRIA AUTORA",
    "PROPRIO AUTOR",
    "PROPRIA AUTORA",
    "SELF",
    "SELF_AUTHOR"
  ]);

  if (selfAliases.has(key)) return "SELF_AUTHOR";

  return name;
}

function buildSimpleNarrativeClusters(memories) {
  const ordered = [...memories].sort((a, b) => {
    const da = safeDate(a.created_at)?.getTime() ?? 0;
    const db = safeDate(b.created_at)?.getTime() ?? 0;
    if (da !== db) return da - db;
    return Number(a.memory_id) - Number(b.memory_id);
  });

  const byPhase = new Map();

  for (const memory of ordered) {
    const phase = normalizeText(memory.phase_code, "SEM_FASE");
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(memory);
  }

  const clusters = [];

  for (const [phaseCode, items] of byPhase.entries()) {
    for (let i = 0; i < items.length; i += 5) {
      const chunk = items.slice(i, i + 5);

      if (chunk.length) {
        clusters.push({
          phase_code: phaseCode,
          memories: chunk,
        });
      }
    }
  }

  return clusters;
}

function suggestChapterFromCluster(cluster) {
  const memories = cluster.memories || [];
  const titles = memories.map((m) => normalizeText(m.title, "")).filter(Boolean);

  const firstTitle = titles[0] || "CapÃ­tulo narrativo";

  const phase =
    cluster.phase_code && cluster.phase_code !== "SEM_FASE"
      ? cluster.phase_code
      : null;

  return {
    suggested_title: phase ? `${firstTitle} â€” ${phase}` : firstTitle,
    suggested_subtitle:
      memories.length > 1
        ? `Um capÃ­tulo construÃ­do a partir de ${memories.length} memÃ³rias conectadas.`
        : "Um capÃ­tulo construÃ­do a partir de uma memÃ³ria central.",
    narrative_intent:
      "Organizar memÃ³rias reais em sequÃªncia editorial preservando a voz do autor.",
    tone: "autobiogrÃ¡fico",
    source_policy: "Somente memÃ³rias reais do autor. Sem conteÃºdo inventado.",
  };
}

function inferChapterTitle(memories, requestedTitle) {
  const customTitle = normalizeText(requestedTitle, "");
  if (customTitle) return customTitle;

  const first = memories[0];
  const firstTitle = normalizeText(first?.title, "");

  if (firstTitle) return firstTitle;

  return "CapÃ­tulo narrativo";
}

function buildDeterministicChapter(memories, options = {}) {
  const tone = normalizeText(options.tone, "autobiogrÃ¡fico");
  const style = normalizeText(options.style, "editorial");
  const intensity = clampInt(options.intensity, 1, 10, 7);
  const preserveVoice = options.preserve_voice !== false;

  const chapterTitle = inferChapterTitle(memories, options.title);

  const intro =
    intensity >= 8
      ? "HÃ¡ memÃ³rias que nÃ£o vivem isoladas. Elas se aproximam, se reconhecem e revelam uma travessia."
      : "Este capÃ­tulo reÃºne memÃ³rias que, juntas, formam uma parte importante da trajetÃ³ria do autor.";

  const body = memories
    .map((memory, index) => {
      const title = normalizeText(memory.title, `MemÃ³ria ${index + 1}`);
      const content = normalizeText(memory.content, "");
      const preview = content || "Esta memÃ³ria ainda nÃ£o possui conteÃºdo textual suficiente.";

      return [
        index === 0 ? "" : "\n",
        `### ${title}`,
        "",
        preserveVoice ? preview : preview.replace(/\s+/g, " ").trim(),
      ].join("\n");
    })
    .join("\n");

  const closing =
    "Ao reunir essas memÃ³rias, o capÃ­tulo preserva a origem dos acontecimentos e organiza a experiÃªncia em uma sequÃªncia narrativa fiel ao autor.";

  return {
    chapter_title: chapterTitle,
    chapter_content: [intro, body, closing].filter(Boolean).join("\n\n"),
    emotional_arc:
      "MemÃ³rias organizadas em progressÃ£o autobiogrÃ¡fica, preservando origem, contexto e voz autoral.",
    tone,
    style,
    intensity,
    preserve_voice: preserveVoice,
    source_policy: "Somente memÃ³rias reais do autor. Sem conteÃºdo inventado.",
  };
}

router.get("/clusters", authRequired, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "NÃ£o autenticado.",
      });
    }

    const pool = await getPool();

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          m.memory_id,
          m.author_id,
          m.title,
          m.content,
          m.created_at,
          p.phase_code
        FROM dbo.identity_memory m
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        WHERE m.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0
        ORDER BY
          m.created_at ASC,
          m.memory_id ASC;
      `);

    const memories = result.recordset || [];
    const clusters = buildSimpleNarrativeClusters(memories);

    const suggestions = clusters.map((cluster, index) => ({
      cluster_index: index + 1,
      phase_code:
        cluster.phase_code && cluster.phase_code !== "SEM_FASE"
          ? cluster.phase_code
          : null,
      total_memories: cluster.memories.length,
      memories: cluster.memories.map((memory) => ({
        memory_id: Number(memory.memory_id),
        title: normalizeText(memory.title, "(MemÃ³ria sem tÃ­tulo)"),
        preview: makePreview(memory.content),
        created_at: memory.created_at || null,
      })),
      suggestion: suggestChapterFromCluster(cluster),
    }));

    return res.json({
      ok: true,
      engine: "HDUD Narrative Engine v2",
      author_id: authorId,
      total_memories: memories.length,
      total_clusters: clusters.length,
      suggestions,
      meta: {
        generated_at: new Date().toISOString(),
        mode: "deterministic_v1",
        ai_enabled: false,
      },
    });
  } catch (err) {
    console.error("[NARRATIVE_CLUSTERS_ERROR]", err);

    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar clusters narrativos.",
      detail: err?.message || "Erro interno.",
    });
  }
});

router.post("/generate-chapter", authRequired, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "NÃ£o autenticado.",
      });
    }

    const memoryIds = normalizeMemoryIds(req.body?.memory_ids);

    if (!memoryIds.length) {
      return res.status(400).json({
        ok: false,
        error: "memory_ids obrigatÃ³rio.",
        detail: "Envie memory_ids como array de IDs de memÃ³rias reais do autor.",
      });
    }

    const pool = await getPool();
    const request = pool.request().input("author_id", sql.Int, authorId);

    memoryIds.forEach((id, index) => {
      request.input(`memory_id_${index}`, sql.Int, id);
    });

    const placeholders = memoryIds.map((_, index) => `@memory_id_${index}`).join(",");

    const result = await request.query(`
      SELECT
        m.memory_id,
        m.title,
        m.content,
        m.created_at,
        m.published_at,
        p.phase_code
      FROM dbo.identity_memory m
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
        AND m.memory_id IN (${placeholders});
    `);

    const found = result.recordset || [];

    if (found.length !== memoryIds.length) {
      const foundIds = new Set(found.map((m) => Number(m.memory_id)));
      const missing = memoryIds.filter((id) => !foundIds.has(id));

      return res.status(404).json({
        ok: false,
        error: "Uma ou mais memÃ³rias nÃ£o foram encontradas para este autor.",
        missing_memory_ids: missing,
      });
    }

    const byId = new Map(found.map((memory) => [Number(memory.memory_id), memory]));
    const orderedMemories = memoryIds.map((id) => byId.get(id)).filter(Boolean);

    let aiResult = null;

    try {
      aiResult = await generateNarrativeChapterWithOpenAI({
        memories: orderedMemories,
        options: {
          title: req.body?.title,
          tone: req.body?.tone,
          style: req.body?.style,
          intensity: req.body?.intensity,
          preserve_voice: req.body?.preserve_voice,
        },
      });
    } catch (aiErr) {
      console.error("[OPENAI_NARRATIVE_ERROR]", aiErr);
    }

    if (aiResult?.ok && aiResult?.chapter) {
      return res.json({
        ok: true,
        engine: "HDUD Narrative Engine v2",
        mode: "openai_live",
        ai_enabled: true,
        ai_model: aiResult.model || null,
        author_id: authorId,
        source_memories: orderedMemories.map((memory, index) => ({
          order: index + 1,
          memory_id: Number(memory.memory_id),
          title: normalizeText(memory.title, "(MemÃ³ria sem tÃ­tulo)"),
          phase_code: memory.phase_code || null,
          created_at: memory.created_at || null,
          published_at: memory.published_at || null,
        })),
        chapter: aiResult.chapter,
        meta: {
          generated_at: new Date().toISOString(),
          source_policy: "Sem fake. Sem memÃ³ria inventada. Sem conteÃºdo externo.",
          fallback_used: false,
        },
      });
    }

    const chapter = buildDeterministicChapter(orderedMemories, {
      title: req.body?.title,
      tone: req.body?.tone,
      style: req.body?.style,
      intensity: req.body?.intensity,
      preserve_voice: req.body?.preserve_voice,
    });

    return res.json({
      ok: true,
      engine: "HDUD Narrative Engine v2",
      mode: "deterministic_fallback",
      ai_enabled: false,
      author_id: authorId,
      source_memories: orderedMemories.map((memory, index) => ({
        order: index + 1,
        memory_id: Number(memory.memory_id),
        title: normalizeText(memory.title, "(MemÃ³ria sem tÃ­tulo)"),
        phase_code: memory.phase_code || null,
        created_at: memory.created_at || null,
        published_at: memory.published_at || null,
      })),
      chapter,
      meta: {
        generated_at: new Date().toISOString(),
        source_policy: "Sem fake. Sem memÃ³ria inventada. Sem conteÃºdo externo.",
        fallback_used: true,
        fallback_reason: aiResult?.reason || "OpenAI indisponÃ­vel.",
      },
    });
  } catch (err) {
    console.error("[NARRATIVE_GENERATE_CHAPTER_ERROR]", err);

    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar capÃ­tulo narrativo.",
      detail: err?.message || "Erro interno.",
    });
  }
});

router.post("/refine-memory", authRequired, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "NÃ£o autenticado.",
      });
    }

    const memoryId = Number(req.body?.memory_id);

    if (!Number.isInteger(memoryId) || memoryId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "memory_id invÃ¡lido.",
      });
    }

    const pool = await getPool();

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("memory_id", sql.Int, memoryId)
      .query(`
        SELECT
          m.memory_id,
          m.author_id,
          m.title,
          m.content,
          p.phase_code
        FROM dbo.identity_memory m
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        WHERE m.author_id = @author_id
          AND m.memory_id = @memory_id
          AND ISNULL(m.is_deleted, 0) = 0;
      `);

    const memory = result.recordset?.[0];

    if (!memory) {
      return res.status(404).json({
        ok: false,
        error: "MemÃ³ria nÃ£o encontrada.",
      });
    }

    const voiceProfile = await loadLatestVoiceProfile(pool, authorId);

    let aiResult = null;

    try {
      aiResult = await refineMemoryWithOpenAI({
        memory,
        options: {
          mode: req.body?.mode,
          preserve_voice: req.body?.preserve_voice,
          intensity: req.body?.intensity,
          language: req.body?.language,
        },
        voiceProfile,
        usageContext: {
          userId: Number(req.user?.user_id || req.user?.userId || req.user?.id || req.user?.uid || req.user?.sub) || null,
          authorId,
          operationCode: "MEMORY_EDITORIAL_REFINE",
          entityType: "MEMORY",
          entityId: memoryId,
        },
      });
    } catch (err) {
      console.error("[MEMORY_REFINER_ERROR]", err);
    }

    if (aiResult?.ok && aiResult?.result) {
      return res.json({
        ok: true,
        engine: "HDUD Memory Refiner v2",
        mode: "openai_live",
        ai_enabled: true,
        ai_model: aiResult.model || null,
        memory: {
          memory_id: Number(memory.memory_id),
          original_title: memory.title || null,
          original_content: memory.content || null,
          phase_code: memory.phase_code || null,
        },
        refinement: aiResult.result,
		  editorial_guard:
			aiResult.editorial_guard || null,
        voice_profile: voiceProfile
          ? {
              loaded: true,
              voice_profile_id: voiceProfile.voice_profile_id,
              writing_style: voiceProfile.writing_style,
              emotional_tone: voiceProfile.emotional_tone,
              narrative_density: voiceProfile.narrative_density,
              emotional_intensity: voiceProfile.emotional_intensity,
              preferred_language: voiceProfile.preferred_language,
              sample_size_memories: voiceProfile.sample_size_memories,
            }
          : {
              loaded: false,
            },
        meta: {
          generated_at: new Date().toISOString(),
          source_policy: "Sem fake. Sem conteÃºdo inventado.",
        },
      });
    }

    const reason = aiResult?.reason || "OpenAI indisponível.";

	if (reason === "EDITORIAL_CONTENT_LOSS_DETECTED") {
	  return res.status(422).json({
		ok: false,

		error: "EDITORIAL_CONTENT_LOSS_DETECTED",

		message:
		  "A sugestão editorial apresentou risco de perda de conteúdo e foi rejeitada automaticamente.",

		editorial_guard:
		  aiResult?.editorial_guard || null,

		memory: {
		  memory_id: Number(memory.memory_id),
		  title: memory.title || null,
		},

		voice_profile_loaded: Boolean(
		  voiceProfile
		),

		retry_allowed: true,

		source_policy:
		  "Memória original preservada. Nenhuma alteração foi aplicada.",
	  });
	}

	return res.status(500).json({
	  ok: false,
	  error: "Falha no refinamento IA.",
	  detail: reason,
	  voice_profile_loaded: Boolean(
		voiceProfile
	  ),
	});
  } catch (err) {
    console.error("[REFINE_MEMORY_ROUTE_ERROR]", err);

    return res.status(500).json({
      ok: false,
      error: "Erro ao refinar memÃ³ria.",
      detail: err?.message || "Erro interno.",
    });
  }
});

router.post("/build-voice-profile", authRequired, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "NÃ£o autenticado.",
      });
    }

    const limit = clampInt(req.body?.limit, 5, 100, 30);

    const pool = await getPool();

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          m.memory_id,
          m.title,
          m.content,
          p.phase_code
        FROM dbo.identity_memory m
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        WHERE m.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0
          AND NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(MAX), m.content))), '') IS NOT NULL
        ORDER BY
          COALESCE(m.published_at, m.created_at) DESC,
          m.memory_id DESC;
      `);

    const memories = result.recordset || [];

    if (!memories.length) {
      return res.status(404).json({
        ok: false,
        error: "Nenhuma memÃ³ria encontrada para gerar perfil de voz.",
      });
    }

    const aiResult = await generateVoiceProfile({
      authorId,
      memories,
    });

    if (!aiResult?.ok || !aiResult?.profile) {
      return res.status(500).json({
        ok: false,
        error: "Falha ao gerar perfil de voz.",
        detail: aiResult?.reason || "OpenAI indisponÃ­vel.",
      });
    }

    const profile = aiResult.profile;

    const normalizedProfile = {
      writing_style: normalizeProfileText(profile.writing_style, 100),
      emotional_tone: normalizeProfileText(profile.emotional_tone, 100),
      narrative_density: normalizeProfileInt(profile.narrative_density, 0, 10),
      sentence_length_avg: normalizeProfileInt(profile.sentence_length_avg, 0, 500),
      emotional_intensity: normalizeProfileInt(profile.emotional_intensity, 0, 10),
      preferred_language:
        normalizeProfileText(profile.preferred_language, 20) || "pt-BR",
      ai_observations: normalizeProfileObservations(profile.ai_observations),
    };

    await pool
      .request()
      .input("author_id", sql.BigInt, authorId)
      .input("writing_style", sql.NVarChar(100), normalizedProfile.writing_style)
      .input("emotional_tone", sql.NVarChar(100), normalizedProfile.emotional_tone)
      .input("narrative_density", sql.Int, normalizedProfile.narrative_density)
      .input("sentence_length_avg", sql.Int, normalizedProfile.sentence_length_avg)
      .input("emotional_intensity", sql.Int, normalizedProfile.emotional_intensity)
      .input("preferred_language", sql.VarChar(20), normalizedProfile.preferred_language)
      .input("ai_observations", sql.NVarChar(sql.MAX), normalizedProfile.ai_observations)
      .input("sample_size_memories", sql.Int, memories.length)
      .query(`
        INSERT INTO dbo.identity_author_voice_profile
        (
          author_id,
          writing_style,
          emotional_tone,
          narrative_density,
          sentence_length_avg,
          emotional_intensity,
          preferred_language,
          ai_observations,
          sample_size_memories
        )
        VALUES
        (
          @author_id,
          @writing_style,
          @emotional_tone,
          @narrative_density,
          @sentence_length_avg,
          @emotional_intensity,
          @preferred_language,
          @ai_observations,
          @sample_size_memories
        );
      `);

    return res.json({
      ok: true,
      engine: "HDUD Voice Profile Engine v1",
      mode: "openai_live",
      ai_enabled: true,
      ai_model: aiResult.model || null,
      author_id: authorId,
      sample_size_memories: memories.length,
      voice_profile: {
        raw: profile,
        normalized: normalizedProfile,
      },
      meta: {
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[BUILD_VOICE_PROFILE_ERROR]", err);

    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar perfil de voz.",
      detail: err?.message || "Erro interno.",
    });
  }
});

router.post(
  "/extract-entities",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "NÃ£o autenticado.",
        });
      }

      const memoryId = Number(
        req.body?.memory_id
      );

      if (
        !Number.isInteger(memoryId) ||
        memoryId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "memory_id invÃ¡lido.",
        });
      }

      const pool = await getPool();

      const memoryResult = await pool
        .request()
        .input(
          "author_id",
          sql.BigInt,
          authorId
        )
        .input(
          "memory_id",
          sql.BigInt,
          memoryId
        )
        .query(`
          SELECT
            m.memory_id,
            m.title,
            m.content,
            p.phase_code
          FROM dbo.identity_memory m
          LEFT JOIN dbo.identity_phase p
            ON p.phase_id = m.phase_id
          WHERE m.author_id = @author_id
            AND m.memory_id = @memory_id
            AND ISNULL(m.is_deleted,0)=0
        `);

      const memory =
        memoryResult.recordset?.[0];

      if (!memory) {
        return res.status(404).json({
          ok: false,
          error:
            "MemÃ³ria nÃ£o encontrada.",
        });
      }

      const aiResult =
        await extractNarrativeEntities({
          memory,
        });

      if (!aiResult?.ok) {
        return res.status(500).json({
          ok: false,
          error:
            "Falha na extraÃ§Ã£o narrativa.",
          detail:
            aiResult?.reason ||
            "OpenAI indisponÃ­vel.",
        });
      }

      const persistedEntities = [];

      for (const entity of aiResult.entities) {
        const normalizedEntityName =
          normalizeNarrativeEntityName(
            entity.entity_name
          );

        let entityName =
          normalizeText(
            normalizedEntityName,
            ""
          );

        let entityType =
          entityName === "SELF_AUTHOR"
            ? "SELF"
            : normalizeText(
                entity.entity_type,
                ""
              ).toUpperCase();

        if (
          !entityType ||
          !entityName
        ) {
          continue;
        }

        // ======================================
        // ENTITY RESOLUTION ENGINE
        // ======================================

        const resolution =
          await resolveNarrativeEntity({
            authorId,
            entityType,
            entityName,
          });

        if (
          resolution?.ok &&
          resolution?.entity?.canonical_name
        ) {
          entityName =
            resolution.entity.canonical_name;

          entityType =
            entityName === "SELF_AUTHOR"
              ? "SELF"
              : entityType;
        }

        const emotionalWeight =
          clampInt(
            entity.emotional_weight,
            0,
            10,
            5
          );

        const emotionalRelevance =
          clampInt(
            entity.emotional_relevance,
            0,
            10,
            5
          );

        const relationshipType =
          entityName === "SELF_AUTHOR"
            ? "AUTHOR"
            : normalizeText(
                entity.relationship_type,
                null
              );

        const summary =
          normalizeText(
            entity.summary,
            null
          );

        // ======================================
        // UPSERT ENTITY (IDEMPOTENT)
        // recurrence_count is updated only when
        // a new memory ↔ entity link is created.
        // ======================================

        const entityResult =
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
              entityName
            )
            .input(
              "memory_id",
              sql.BigInt,
              memoryId
            )
            .input(
              "emotional_relevance",
              sql.Int,
              emotionalRelevance
            )
            .input(
              "summary",
              sql.NVarChar(sql.MAX),
              summary
            )
            .query(`
              SET NOCOUNT ON;

              DECLARE @entity_id BIGINT;

              SELECT
                @entity_id = entity_id
              FROM dbo.identity_narrative_entity
              WHERE author_id = @author_id
                AND entity_type = @entity_type
                AND entity_name = @entity_name;

              IF @entity_id IS NULL
              BEGIN
                INSERT INTO dbo.identity_narrative_entity
                (
                  author_id,
                  entity_type,
                  entity_name,
                  first_memory_id,
                  emotional_relevance,
                  ai_summary,
                  recurrence_count,
                  first_seen_at,
                  last_seen_at,
                  narrative_role,
                  importance_score
                )
                VALUES
                (
                  @author_id,
                  @entity_type,
                  @entity_name,
                  @memory_id,
                  @emotional_relevance,
                  @summary,
                  0,
                  SYSUTCDATETIME(),
                  SYSUTCDATETIME(),
                  CASE
                    WHEN @entity_type = 'SELF'
                    THEN 'SELF_AUTHOR'
                    ELSE NULL
                  END,
                  @emotional_relevance
                );

                SET @entity_id = SCOPE_IDENTITY();
              END
              ELSE
              BEGIN
                UPDATE dbo.identity_narrative_entity
                SET
                  emotional_relevance =
                    CASE
                      WHEN ISNULL(emotional_relevance, 0) < @emotional_relevance
                      THEN @emotional_relevance
                      ELSE emotional_relevance
                    END,
                  importance_score =
                    CASE
                      WHEN ISNULL(importance_score, 0) < @emotional_relevance
                      THEN @emotional_relevance
                      ELSE importance_score
                    END,
                  ai_summary = COALESCE(ai_summary, @summary),
                  narrative_role =
                    CASE
                      WHEN @entity_type = 'SELF'
                      THEN 'SELF_AUTHOR'
                      ELSE narrative_role
                    END
                WHERE entity_id = @entity_id;
              END

              SELECT @entity_id AS entity_id;
            `);

        const entityId =
          entityResult.recordset?.[0]
            ?.entity_id;

        if (!entityId) {
          continue;
        }

        // ======================================
        // LINK MEMORY ↔ ENTITY (IDEMPOTENT)
        // ======================================

        const linkResult =
          await pool
            .request()
            .input(
              "memory_id",
              sql.BigInt,
              memoryId
            )
            .input(
              "entity_id",
              sql.BigInt,
              entityId
            )
            .input(
              "relationship_type",
              sql.VarChar(50),
              relationshipType
            )
            .input(
              "emotional_weight",
              sql.Int,
              emotionalWeight
            )
            .query(`
              SET NOCOUNT ON;

              DECLARE @created BIT = 0;

              IF NOT EXISTS (
                SELECT 1
                FROM dbo.identity_memory_entity
                WHERE memory_id = @memory_id
                  AND entity_id = @entity_id
              )
              BEGIN
                INSERT INTO dbo.identity_memory_entity
                (
                  memory_id,
                  entity_id,
                  relationship_type,
                  emotional_weight
                )
                VALUES
                (
                  @memory_id,
                  @entity_id,
                  @relationship_type,
                  @emotional_weight
                );

                SET @created = 1;
              END
              ELSE
              BEGIN
                UPDATE dbo.identity_memory_entity
                SET
                  emotional_weight =
                    CASE
                      WHEN ISNULL(emotional_weight, 0) < @emotional_weight
                      THEN @emotional_weight
                      ELSE emotional_weight
                    END,
                  relationship_type =
                    COALESCE(relationship_type, @relationship_type)
                WHERE memory_id = @memory_id
                  AND entity_id = @entity_id;
              END

              SELECT @created AS created;
            `);

        const linkCreated =
          Boolean(
            linkResult.recordset?.[0]
              ?.created
          );

        if (linkCreated) {
          await pool
            .request()
            .input(
              "entity_id",
              sql.BigInt,
              entityId
            )
            .input(
              "emotional_relevance",
              sql.Int,
              emotionalRelevance
            )
            .query(`
              UPDATE dbo.identity_narrative_entity
              SET
                recurrence_count =
                  ISNULL(recurrence_count, 0) + 1,
                last_seen_at =
                  SYSUTCDATETIME(),
                importance_score =
                  CASE
                    WHEN ISNULL(importance_score, 0) < @emotional_relevance
                    THEN @emotional_relevance
                    ELSE importance_score
                  END
              WHERE entity_id = @entity_id;
            `);
        }

        persistedEntities.push({
          entity_id: Number(entityId),
          entity_type: entityType,
          entity_name: entityName,
          relationship_type:
            relationshipType,
          emotional_weight:
            emotionalWeight,
          emotional_relevance:
            emotionalRelevance,
          link_created:
            linkCreated,
        });
      }

      return res.json({
        ok: true,

        engine:
          "HDUD Entity Extraction Engine v2",

        mode: "openai_live",

        ai_enabled: true,

        ai_model:
          aiResult.model || null,

        memory: {
          memory_id:
            Number(memory.memory_id),

          title:
            memory.title || null,

          phase_code:
            memory.phase_code ||
            null,
        },

        total_entities:
          persistedEntities.length,

        entities:
          persistedEntities,

        meta: {
          generated_at:
            new Date().toISOString(),

          source_policy:
            "Somente entidades reais detectadas na memÃ³ria. SELF_AUTHOR é entidade canônica estrutural.",
          graph_idempotent:
            true,
        },
      });
    } catch (err) {
      console.error(
        "[ENTITY_EXTRACTION_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro na extraÃ§Ã£o narrativa.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);


router.post(
  "/extract-timeline",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "NÃ£o autenticado.",
        });
      }

      const memoryId = Number(
        req.body?.memory_id
      );

      if (
        !Number.isInteger(memoryId) ||
        memoryId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "memory_id invÃ¡lido.",
        });
      }

      const pool = await getPool();

      const memoryResult = await pool
        .request()
        .input(
          "author_id",
          sql.BigInt,
          authorId
        )
        .input(
          "memory_id",
          sql.BigInt,
          memoryId
        )
        .query(`
          SELECT
            m.memory_id,
            m.title,
            m.content,
            NULL AS memory_date,
            m.created_at,
            m.published_at,
            p.phase_code
          FROM dbo.identity_memory m
          LEFT JOIN dbo.identity_phase p
            ON p.phase_id = m.phase_id
          WHERE m.author_id = @author_id
            AND m.memory_id = @memory_id
            AND ISNULL(m.is_deleted,0)=0
        `);

      const memory =
        memoryResult.recordset?.[0];

      if (!memory) {
        return res.status(404).json({
          ok: false,
          error:
            "MemÃ³ria nÃ£o encontrada.",
        });
      }

      const aiResult =
        await extractTimelineEvents({
          memory,
        });

      if (!aiResult?.ok) {
        return res.status(500).json({
          ok: false,
          error:
            "Falha na extraÃ§Ã£o timeline.",
          detail:
            aiResult?.reason ||
            "OpenAI indisponÃ­vel.",
        });
      }

      const persistedEvents = [];

      for (const event of aiResult.timeline_events) {
        const timelineType =
          normalizeText(
            event.timeline_type,
            ""
          ).toUpperCase();

        const title =
          normalizeText(
            event.title,
            ""
          );

        if (
          !timelineType ||
          !title
        ) {
          continue;
        }

        const description =
          normalizeText(
            event.description,
            null
          );

        const emotionalWeight =
          clampInt(
            event.emotional_weight,
            0,
            10,
            5
          );

        const narrativeImportance =
          clampInt(
            event.narrative_importance,
            0,
            10,
            5
          );

        let eventDate = null;

        if (event.event_date) {
          const parsed =
            new Date(event.event_date);

          if (
            !Number.isNaN(
              parsed.getTime()
            )
          ) {
            eventDate =
              parsed.toISOString();
          }
        }

        const insertResult =
          await pool
            .request()
            .input(
              "author_id",
              sql.BigInt,
              authorId
            )
            .input(
              "memory_id",
              sql.BigInt,
              memoryId
            )
            .input(
              "timeline_type",
              sql.VarChar(50),
              timelineType
            )
            .input(
              "title",
              sql.NVarChar(255),
              title
            )
            .input(
              "description",
              sql.NVarChar(sql.MAX),
              description
            )
            .input(
              "event_date",
              sql.DateTime2,
              eventDate
            )
            .input(
              "emotional_weight",
              sql.Int,
              emotionalWeight
            )
            .input(
              "narrative_importance",
              sql.Int,
              narrativeImportance
            )
            .query(`
              INSERT INTO dbo.identity_narrative_timeline
              (
                author_id,
                memory_id,
                timeline_type,
                title,
                description,
                event_date,
                emotional_weight,
                narrative_importance
              )
              VALUES
              (
                @author_id,
                @memory_id,
                @timeline_type,
                @title,
                @description,
                @event_date,
                @emotional_weight,
                @narrative_importance
              );

              SELECT
                SCOPE_IDENTITY()
                AS timeline_event_id;
            `);

        const timelineEventId =
          insertResult.recordset?.[0]
            ?.timeline_event_id;

        persistedEvents.push({
          timeline_event_id:
            Number(
              timelineEventId
            ),

          timeline_type:
            timelineType,

          title,

          emotional_weight:
            emotionalWeight,

          narrative_importance:
            narrativeImportance,

          event_date:
            eventDate,
        });
      }

      return res.json({
        ok: true,

        engine:
          "HDUD Timeline Extraction Engine v1",

        mode: "openai_live",

        ai_enabled: true,

        ai_model:
          aiResult.model || null,

        memory: {
          memory_id:
            Number(memory.memory_id),

          title:
            memory.title || null,

          phase_code:
            memory.phase_code ||
            null,
        },

        total_events:
          persistedEvents.length,

        timeline_events:
          persistedEvents,

        meta: {
          generated_at:
            new Date().toISOString(),

          source_policy:
            "Somente eventos reais detectados na memÃ³ria.",
        },
      });
    } catch (err) {
      console.error(
        "[TIMELINE_EXTRACTION_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro na timeline narrativa.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);

router.post(
  "/extract-relationships",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "NÃ£o autenticado.",
        });
      }

      const memoryId = Number(
        req.body?.memory_id
      );

      if (
        !Number.isInteger(memoryId) ||
        memoryId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "memory_id invÃ¡lido.",
        });
      }

      const pool = await getPool();

      // =========================================
      // LOAD MEMORY
      // =========================================

      const memoryResult = await pool
        .request()
        .input(
          "author_id",
          sql.BigInt,
          authorId
        )
        .input(
          "memory_id",
          sql.BigInt,
          memoryId
        )
        .query(`
          SELECT
            m.memory_id,
            m.title,
            m.content,
            p.phase_code
          FROM dbo.identity_memory m
          LEFT JOIN dbo.identity_phase p
            ON p.phase_id = m.phase_id
          WHERE m.author_id = @author_id
            AND m.memory_id = @memory_id
            AND ISNULL(m.is_deleted,0)=0
        `);

      const memory =
        memoryResult.recordset?.[0];

      if (!memory) {
        return res.status(404).json({
          ok: false,
          error:
            "MemÃ³ria nÃ£o encontrada.",
        });
      }

      // =========================================
      // LOAD ENTITIES
      // =========================================

      const entitiesResult =
        await pool
          .request()
          .input(
            "memory_id",
            sql.BigInt,
            memoryId
          )
          .query(`
            SELECT
              e.entity_id,
              e.entity_type,
              e.entity_name
            FROM dbo.identity_memory_entity me
            INNER JOIN dbo.identity_narrative_entity e
              ON e.entity_id = me.entity_id
            WHERE me.memory_id = @memory_id
          `);

      const entities =
        entitiesResult.recordset || [];

      if (entities.length < 2) {
        return res.status(400).json({
          ok: false,
          error:
            "Entidades insuficientes para anÃ¡lise relacional.",
        });
      }

      // =========================================
      // AI RELATIONSHIP EXTRACTION
      // =========================================

      const aiResult =
        await extractNarrativeRelationships({
          memory,
          entities,
        });

      if (!aiResult?.ok) {
        return res.status(500).json({
          ok: false,
          error:
            "Falha na extraÃ§Ã£o relacional.",
          detail:
            aiResult?.reason ||
            "OpenAI indisponÃ­vel.",
        });
      }

      const persistedRelationships = [];

      for (const rel of aiResult.relationships) {
        const sourceName =
          normalizeNarrativeEntityName(
            rel.source_entity_name
          );

        const targetName =
          normalizeNarrativeEntityName(
            rel.target_entity_name
          );

        const relationshipType =
          normalizeText(
            rel.relationship_type,
            ""
          ).toUpperCase();

        if (
          !sourceName ||
          !targetName ||
          !relationshipType ||
          sourceName === targetName
        ) {
          continue;
        }

        const sourceEntity =
          entities.find(
            (e) =>
              normalizeNarrativeEntityName(
                e.entity_name
              ) === sourceName
          );

        const targetEntity =
          entities.find(
            (e) =>
              normalizeNarrativeEntityName(
                e.entity_name
              ) === targetName
          );

        if (
          !sourceEntity ||
          !targetEntity
        ) {
          continue;
        }

        const emotionalStrength =
          clampInt(
            rel.emotional_strength,
            0,
            10,
            5
          );

        const narrativeWeight =
          clampInt(
            rel.narrative_weight,
            0,
            10,
            5
          );

        const summary =
          normalizeText(
            rel.summary,
            null
          );

        // ======================================
        // UPSERT GLOBAL RELATIONSHIP
        // ======================================

        const relationshipResult =
          await pool
            .request()
            .input(
              "author_id",
              sql.BigInt,
              authorId
            )
            .input(
              "source_entity_id",
              sql.BigInt,
              sourceEntity.entity_id
            )
            .input(
              "target_entity_id",
              sql.BigInt,
              targetEntity.entity_id
            )
            .input(
              "relationship_type",
              sql.VarChar(100),
              relationshipType
            )
            .input(
              "emotional_strength",
              sql.Int,
              emotionalStrength
            )
            .input(
              "narrative_weight",
              sql.Int,
              narrativeWeight
            )
            .input(
              "memory_id",
              sql.BigInt,
              memoryId
            )
            .query(`
              SET NOCOUNT ON;

              DECLARE @relationship_id BIGINT;

              SELECT
                @relationship_id =
                  relationship_id
              FROM dbo.identity_narrative_relationship
              WHERE author_id = @author_id
                AND source_entity_id =
                    @source_entity_id
                AND target_entity_id =
                    @target_entity_id
                AND relationship_type =
                    @relationship_type;

              IF @relationship_id IS NULL
              BEGIN
                INSERT INTO dbo.identity_narrative_relationship
                (
                  author_id,
                  source_entity_id,
                  target_entity_id,
                  relationship_type,
                  emotional_strength,
                  narrative_weight,
                  first_memory_id,
                  updated_at
                )
                VALUES
                (
                  @author_id,
                  @source_entity_id,
                  @target_entity_id,
                  @relationship_type,
                  @emotional_strength,
                  @narrative_weight,
                  @memory_id,
                  SYSUTCDATETIME()
                );

                SET @relationship_id =
                  SCOPE_IDENTITY();
              END
              ELSE
              BEGIN
                UPDATE dbo.identity_narrative_relationship
                SET
                  emotional_strength =
                    CASE
                      WHEN ISNULL(emotional_strength, 0) <
                        @emotional_strength
                      THEN @emotional_strength
                      ELSE emotional_strength
                    END,

                  narrative_weight =
                    CASE
                      WHEN ISNULL(narrative_weight, 0) <
                        @narrative_weight
                      THEN @narrative_weight
                      ELSE narrative_weight
                    END,

                  updated_at =
                    SYSUTCDATETIME()
                WHERE relationship_id =
                    @relationship_id;
              END

              SELECT
                @relationship_id
                AS relationship_id;
            `);

        const relationshipId =
          relationshipResult.recordset?.[0]
            ?.relationship_id;

        if (!relationshipId) {
          continue;
        }

        // ======================================
        // LINK MEMORY ↔ RELATIONSHIP
        // Requires dbo.identity_memory_relationship
        // UNIQUE(memory_id, relationship_id)
        // ======================================

        const memoryRelationshipResult =
          await pool
            .request()
            .input(
              "memory_id",
              sql.BigInt,
              memoryId
            )
            .input(
              "relationship_id",
              sql.BigInt,
              relationshipId
            )
            .input(
              "emotional_strength",
              sql.Int,
              emotionalStrength
            )
            .input(
              "narrative_weight",
              sql.Int,
              narrativeWeight
            )
            .query(`
              SET NOCOUNT ON;

              DECLARE @created BIT = 0;

              IF NOT EXISTS (
                SELECT 1
                FROM dbo.identity_memory_relationship
                WHERE memory_id = @memory_id
                  AND relationship_id = @relationship_id
              )
              BEGIN
                INSERT INTO dbo.identity_memory_relationship
                (
                  memory_id,
                  relationship_id,
                  emotional_strength,
                  narrative_weight
                )
                VALUES
                (
                  @memory_id,
                  @relationship_id,
                  @emotional_strength,
                  @narrative_weight
                );

                SET @created = 1;
              END
              ELSE
              BEGIN
                UPDATE dbo.identity_memory_relationship
                SET
                  emotional_strength =
                    CASE
                      WHEN ISNULL(emotional_strength, 0) <
                        @emotional_strength
                      THEN @emotional_strength
                      ELSE emotional_strength
                    END,
                  narrative_weight =
                    CASE
                      WHEN ISNULL(narrative_weight, 0) <
                        @narrative_weight
                      THEN @narrative_weight
                      ELSE narrative_weight
                    END
                WHERE memory_id = @memory_id
                  AND relationship_id = @relationship_id;
              END

              SELECT @created AS created;
            `);

        const memoryRelationshipCreated =
          Boolean(
            memoryRelationshipResult.recordset?.[0]
              ?.created
          );

        persistedRelationships.push({
          relationship_id:
            Number(relationshipId),

          source_entity:
            sourceName,

          target_entity:
            targetName,

          relationship_type:
            relationshipType,

          emotional_strength:
            emotionalStrength,

          narrative_weight:
            narrativeWeight,

          summary,

          memory_relationship_created:
            memoryRelationshipCreated,
        });
      }

      return res.json({
        ok: true,

        engine:
          "HDUD Relationship Extraction Engine v2",

        mode: "openai_live",

        ai_enabled: true,

        ai_model:
          aiResult.model || null,

        memory: {
          memory_id:
            Number(memory.memory_id),

          title:
            memory.title || null,

          phase_code:
            memory.phase_code ||
            null,
        },

        total_relationships:
          persistedRelationships.length,

        relationships:
          persistedRelationships,

        meta: {
          generated_at:
            new Date().toISOString(),

          source_policy:
            "Somente relaÃ§Ãµes reais detectadas na memÃ³ria.",
          graph_idempotent:
            true,
          memory_relationship_link:
            true,
        },
      });
    } catch (err) {
      console.error(
        "[RELATIONSHIP_EXTRACTION_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro na extraÃ§Ã£o relacional.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);


router.get(
  "/relationships/evolution",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit =
        clampInt(
          req.query?.limit,
          1,
          100,
          25
        );

      const result =
        await listRelationshipEvolutions({
          authorId,
          limit,
        });

      return res.json({
        ok: true,
        engine:
          "HDUD Relationship Evolution Engine v1",
        author_id:
          authorId,
        ...result,
        meta: {
          generated_at:
            new Date().toISOString(),
          source_policy:
            "Somente relações reais persistidas no grafo narrativo.",
        },
      });
    } catch (err) {
      console.error(
        "[RELATIONSHIP_EVOLUTION_LIST_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao listar evolução relacional.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);

router.get(
  "/relationships/:relationshipId/evolution",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const relationshipId =
        Number(req.params?.relationshipId);

      if (
        !Number.isInteger(relationshipId) ||
        relationshipId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "relationshipId inválido.",
        });
      }

      const result =
        await getRelationshipEvolution({
          authorId,
          relationshipId,
        });

      if (!result?.ok) {
        return res.status(404).json({
          ok: false,
          error:
            result?.reason ||
            "Relação narrativa não encontrada.",
        });
      }

      return res.json({
        ok: true,
        engine:
          "HDUD Relationship Evolution Engine v1",
        author_id:
          authorId,
        ...result,
        meta: {
          generated_at:
            new Date().toISOString(),
          source_policy:
            "Somente relações reais persistidas no grafo narrativo.",
        },
      });
    } catch (err) {
      console.error(
        "[RELATIONSHIP_EVOLUTION_DETAIL_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao carregar evolução relacional.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);



router.get(
  "/emotional-clusters",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit =
        clampInt(
          req.query?.limit,
          10,
          500,
          200
        );

      const result =
        await buildEmotionalClusters({
          authorId,
          limit,
        });

      return res.json({
        ok: true,
        engine:
          "HDUD Emotional Cluster Engine v1",
        author_id:
          authorId,
        ...result,
        meta: {
          generated_at:
            new Date().toISOString(),
          source_policy:
            "Somente dados reais persistidos no Living Narrative Graph.",
        },
      });
    } catch (err) {
      console.error(
        "[EMOTIONAL_CLUSTER_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao gerar clusters emocionais.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);



router.get(
  "/arcs",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit =
        clampInt(
          req.query?.limit,
          50,
          1000,
          300
        );

      const result =
        await buildNarrativeArcs({
          authorId,
          limit,
        });

      return res.json({
        ok: true,
        engine:
          "HDUD Narrative Arc Engine v1",
        author_id:
          authorId,
        ...result,
        meta: {
          generated_at:
            new Date().toISOString(),
          source_policy:
            "Somente dados reais persistidos no Living Narrative Graph.",
          cognition_layer:
            "AUTOBIOGRAPHICAL_TRAJECTORY",
        },
      });
    } catch (err) {
      console.error(
        "[NARRATIVE_ARC_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao gerar arcos narrativos.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);
router.get(
  "/context",
  authRequired,
  async (req, res) => {
    try {

      const authorId =
        getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const memoryIds =
        Array.isArray(
          req.query?.memory_ids
        )
          ? req.query.memory_ids
          : typeof req.query?.memory_ids ===
            "string"
          ? req.query.memory_ids
              .split(",")
          : [];

      const result =
        await loadAuthorNarrativeContext({
          authorId,
          memoryIds,
        });

      return res.json(result);

    } catch (err) {

      console.error(
        "[NARRATIVE_CONTEXT_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao carregar contexto narrativo.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);

router.get(
  "/memory-recall/:memoryId",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const memoryId = Number(req.params?.memoryId);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "memoryId inválido.",
        });
      }

      const limit = clampInt(
        req.query?.limit,
        1,
        100,
        20
      );

      const result = await recallConnectedMemories({
        authorId,
        memoryId,
        limit,
      });

      if (!result?.ok) {
        return res.status(404).json({
          ok: false,
          error: result?.reason || "Memória não encontrada.",
        });
      }

      return res.json(result);
    } catch (err) {
      console.error("[MEMORY_RECALL_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao recuperar memórias conectadas.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

router.get(
  "/cognition",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const result =
        await buildAutobiographicalCognition({
          authorId,
        });

      return res.json(result);
    } catch (err) {
      console.error(
        "[AUTOBIOGRAPHICAL_COGNITION_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao gerar cognição autobiográfica.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);

router.post(
  "/orchestrate-chapter",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const memoryIds = normalizeMemoryIds(
        req.body?.memory_ids
      );

      if (!memoryIds.length) {
        return res.status(400).json({
          ok: false,
          error: "memory_ids obrigatório.",
        });
      }

      const result =
        await orchestrateNarrativeChapter({
          authorId,
          memoryIds,
          options: {
            title: req.body?.title,
            tone: req.body?.tone,
            style: req.body?.style,
            intensity: req.body?.intensity,
            preserve_voice: req.body?.preserve_voice,
          },
        });

      if (!result?.ok) {
        return res.status(500).json({
          ok: false,
          error:
            result?.reason ||
            "Falha ao orquestrar capítulo.",
          raw: result?.raw || null,
        });
      }

      return res.json(result);
    } catch (err) {
      console.error(
        "[ORCHESTRATE_CHAPTER_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao orquestrar capítulo narrativo.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);

router.get(
  "/symbolic-recurrence",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit = clampInt(req.query?.limit, 10, 500, 100);

      const result = await buildSymbolicRecurrence({
        authorId,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error("[SYMBOLIC_RECURRENCE_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao gerar recorrência simbólica.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

router.get(
  "/memory-resonance",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const memoryId = req.query?.memory_id
        ? Number(req.query.memory_id)
        : null;

      const limit = clampInt(req.query?.limit, 5, 200, 50);

      const result = await buildMemoryResonance({
        authorId,
        memoryId,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error("[MEMORY_RESONANCE_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao gerar ressonância entre memórias.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

router.get(
  "/continuity",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit = clampInt(req.query?.limit, 20, 1000, 300);

      const result = await buildNarrativeContinuity({
        authorId,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error("[NARRATIVE_CONTINUITY_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao gerar continuidade narrativa.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

router.get(
  "/cognitive-profile",
  authRequired,
  async (req, res) => {
    try {
      const authorId =
        getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error:
            "Não autenticado.",
        });
      }

      const result =
        await buildAuthorCognitiveProfile({
          authorId,
        });

      return res.json(result);
    } catch (err) {
      console.error(
        "[AUTHOR_COGNITIVE_PROFILE_ERROR]",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Erro ao gerar perfil cognitivo autobiográfico.",
        detail:
          err?.message ||
          "Erro interno.",
      });
    }
  }
);

router.get(
  "/book-orchestration",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit = clampInt(req.query?.limit, 20, 1000, 300);

      const result = await orchestrateAutobiographicalBook({
        authorId,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error("[BOOK_ORCHESTRATION_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao orquestrar estrutura autobiográfica de livro.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

router.get(
  "/life-timeline",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit = clampInt(req.query?.limit, 20, 1000, 300);

      const result = await orchestrateLifeTimeline({
        authorId,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error("[LIFE_TIMELINE_ORCHESTRATION_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao orquestrar linha da vida autobiográfica.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

router.get(
  "/life-event-significance",
  authRequired,
  async (req, res) => {
    try {
      const authorId = getAuthorId(req);

      if (!authorId) {
        return res.status(401).json({
          ok: false,
          error: "Não autenticado.",
        });
      }

      const limit = clampInt(req.query?.limit, 20, 1000, 300);

      const result = await buildLifeEventSignificance({
        authorId,
        limit,
      });

      return res.json(result);
    } catch (err) {
      console.error("[LIFE_EVENT_SIGNIFICANCE_ERROR]", err);

      return res.status(500).json({
        ok: false,
        error: "Erro ao calcular significância autobiográfica de eventos.",
        detail: err?.message || "Erro interno.",
      });
    }
  }
);

export default router;
