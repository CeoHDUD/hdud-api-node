// C:\HDUD_DATA\hdud-api-node\src\routes\narrative.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { buildSimpleNarrativeClusters } from "../services/narrative/narrative-cluster.service.js";
import { suggestChapterFromCluster } from "../services/chapters/chapter-suggestion.service.js";

const router = express.Router();

router.get("/clusters", authRequired, async (req, res) => {
  try {
    const authorId = req.user.author_id;

    const pool = await getPool();

    const result = await pool
      .request()
      .input("authorId", sql.Int, authorId)
      .query(`
        SELECT memory_id, content, memory_date
        FROM identity_memory
        WHERE author_id = @authorId
      `);

    const memories = result.recordset;

    const clusters = buildSimpleNarrativeClusters(memories);

    const suggestions = clusters.map((cluster) => ({
      memories: cluster.map((m) => m.memory_id),
      suggestion: suggestChapterFromCluster(cluster),
    }));

    res.json({
      ok: true,
      total_clusters: clusters.length,
      suggestions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao gerar clusters narrativos" });
  }
});

export default router;
