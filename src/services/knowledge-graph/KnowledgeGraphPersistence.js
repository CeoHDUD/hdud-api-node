import { sql } from '../../db.js';

export class KnowledgeGraphPersistence {
  constructor(pool) {
    if (!pool) throw new Error('KnowledgeGraphPersistence requires pool');
    this.pool = pool;
  }

  async loadAuthorMemories(authorId) {
    const result = await this.pool.request()
      .input('author_id', sql.Int, Number(authorId))
      .query(`
        SELECT memory_id, title, content, created_at, published_at, phase_id
        FROM dbo.identity_memory
        WHERE author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0
        ORDER BY COALESCE(published_at, created_at) ASC, memory_id ASC;
      `);
    return result.recordset || [];
  }

  async saveGraph({ authorId, graph, validation }) {
    const graphJson = JSON.stringify(graph);
    const validationJson = JSON.stringify(validation || {});
    const summary = graph.summary || {};

    const r = await this.pool.request()
      .input('author_id', sql.Int, Number(authorId))
      .input('graph_json', sql.NVarChar(sql.MAX), graphJson)
      .input('node_count', sql.Int, Number(summary.node_count || 0))
      .input('edge_count', sql.Int, Number(summary.edge_count || 0))
      .input('validation_json', sql.NVarChar(sql.MAX), validationJson)
      .query(`
        INSERT INTO dbo.identity_author_knowledge_graph
        (author_id, graph_json, node_count, edge_count, validation_json, created_at)
        OUTPUT INSERTED.graph_id
        VALUES (@author_id, @graph_json, @node_count, @edge_count, @validation_json, SYSUTCDATETIME());
      `);

    for (const node of graph.nodes || []) {
      await this.pool.request()
        .input('author_id', sql.Int, Number(authorId))
        .input('node_key', sql.NVarChar(300), node.key)
        .input('node_type', sql.VarChar(40), node.type)
        .input('label', sql.NVarChar(300), node.label)
        .input('confidence', sql.Decimal(5, 4), Number(node.confidence || 0))
        .input('memory_ids_json', sql.NVarChar(sql.MAX), JSON.stringify(node.memory_ids || []))
        .input('evidence_json', sql.NVarChar(sql.MAX), JSON.stringify(node.evidence || []))
        .query(`
          MERGE dbo.identity_author_knowledge_node AS t
          USING (SELECT @author_id AS author_id, @node_key AS node_key) AS s
          ON t.author_id = s.author_id AND t.node_key = s.node_key
          WHEN MATCHED THEN UPDATE SET
            node_type=@node_type, label=@label, confidence=@confidence,
            memory_ids_json=@memory_ids_json, evidence_json=@evidence_json
          WHEN NOT MATCHED THEN INSERT
            (author_id,node_key,node_type,label,confidence,memory_ids_json,evidence_json)
            VALUES
            (@author_id,@node_key,@node_type,@label,@confidence,@memory_ids_json,@evidence_json);
        `);
    }

    for (const edge of graph.edges || []) {
      await this.pool.request()
        .input('author_id', sql.Int, Number(authorId))
        .input('edge_key', sql.NVarChar(700), edge.key)
        .input('source_key', sql.NVarChar(300), edge.source_key)
        .input('target_key', sql.NVarChar(300), edge.target_key)
        .input('edge_type', sql.VarChar(40), edge.type)
        .input('confidence', sql.Decimal(5, 4), Number(edge.confidence || 0))
        .input('memory_ids_json', sql.NVarChar(sql.MAX), JSON.stringify(edge.memory_ids || []))
        .input('evidence_json', sql.NVarChar(sql.MAX), JSON.stringify(edge.evidence || []))
        .query(`
          MERGE dbo.identity_author_knowledge_edge AS t
          USING (SELECT @author_id AS author_id, @edge_key AS edge_key) AS s
          ON t.author_id = s.author_id AND t.edge_key = s.edge_key
          WHEN MATCHED THEN UPDATE SET
            source_key=@source_key, target_key=@target_key, edge_type=@edge_type,
            confidence=@confidence, memory_ids_json=@memory_ids_json, evidence_json=@evidence_json
          WHEN NOT MATCHED THEN INSERT
            (author_id,edge_key,source_key,target_key,edge_type,confidence,memory_ids_json,evidence_json)
            VALUES
            (@author_id,@edge_key,@source_key,@target_key,@edge_type,@confidence,@memory_ids_json,@evidence_json);
        `);
    }

    return { graph_id: r.recordset?.[0]?.graph_id || null };
  }

  async loadLatestGraph(authorId) {
    const r = await this.pool.request()
      .input('author_id', sql.Int, Number(authorId))
      .query(`
        SELECT TOP 1 graph_id, graph_json, validation_json, created_at
        FROM dbo.identity_author_knowledge_graph
        WHERE author_id = @author_id
        ORDER BY graph_id DESC;
      `);

    const row = r.recordset?.[0];
    if (!row) return null;
    return {
      graph_id: row.graph_id,
      graph: JSON.parse(row.graph_json || '{}'),
      validation: JSON.parse(row.validation_json || '{}'),
      created_at: row.created_at,
    };
  }
}
