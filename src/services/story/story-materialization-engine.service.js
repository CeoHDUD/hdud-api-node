// C:\HDUD_DATA\hdud-api-node\src\services\story\story-materialization-engine.service.js
//
// GO LIVE 008 — Story Materialization Engine (SME)
// Converte uma hipótese/blueprint aprovado em um manuscrito editorial estruturado.
// Regra absoluta: organiza somente conteúdo documental autorizado; nunca cria fatos.

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  return text.length ? text : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMemory(memory, index = 0) {
  const memoryId = Number(memory?.memory_id ?? memory?.id ?? memory?.memoryId) || null;
  return {
    ...memory,
    memory_id: memoryId,
    order_index: index + 1,
    title: safeText(memory?.title || memory?.memory_title, memoryId ? `Memória ${memoryId}` : `Memória ${index + 1}`),
    content: safeText(memory?.content || memory?.description || memory?.summary, ""),
    memory_date: memory?.memory_date || memory?.narrative_date || memory?.event_date || memory?.created_at || null,
  };
}

function dateValue(memory) {
  const date = new Date(memory?.memory_date || "");
  return Number.isNaN(date.getTime()) ? Number.MAX_SAFE_INTEGER : date.getTime();
}

function uniqueParagraphs(values = []) {
  const seen = new Set();
  return values.map((value) => safeText(value, "")).filter((value) => {
    if (!value) return false;
    const key = value.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickClimaxIndex(memories, story) {
  const climaxId = Number(
    story?.story_blueprint?.climax?.memory_id ??
    story?.story_blueprint?.turning_point?.memory_id ??
    story?.narrative_arc?.climax?.memory_id ??
    0
  );
  if (climaxId) {
    const index = memories.findIndex((memory) => Number(memory.memory_id) === climaxId);
    if (index >= 0) return index;
  }
  if (memories.length <= 2) return Math.max(0, memories.length - 1);
  return Math.max(1, Math.min(memories.length - 2, Math.floor(memories.length * 0.66)));
}

export function materializeStoryStructure({ story = {}, memories = [], timeline = [] } = {}) {
  const ordered = asArray(memories)
    .map(normalizeMemory)
    .filter((memory) => memory.content)
    .sort((a, b) => dateValue(a) - dateValue(b) || a.order_index - b.order_index);

  const title = safeText(
    story?.story_blueprint?.title || story?.title || story?.suggested_title || story?.central_theme,
    "História descoberta"
  );
  const question = safeText(
    story?.story_blueprint?.central_question || story?.central_question || story?.question,
    ""
  );
  const transformation = safeText(
    story?.story_blueprint?.transformation || story?.transformation || story?.main_transformation,
    ""
  );
  const summary = safeText(story?.summary || story?.one_line_summary || story?.description, transformation);
  const subtitle = safeText(story?.subtitle, question || summary || transformation);

  if (!ordered.length) {
    return {
      title,
      subtitle,
      lead: "",
      progression: "",
      climax: "",
      closure: "",
      legacy: transformation,
      summary,
      narrative_content: "",
      sections: [],
      used_memories: [],
      timeline: asArray(timeline),
    };
  }

  const climaxIndex = pickClimaxIndex(ordered, story);
  const leadMemory = ordered[0];
  const climaxMemory = ordered[climaxIndex];
  const closureMemory = ordered[ordered.length - 1];
  const progressionMemories = ordered.filter((_, index) => index > 0 && index < climaxIndex);
  const afterClimaxMemories = ordered.filter((_, index) => index > climaxIndex && index < ordered.length - 1);

  const lead = leadMemory.content;
  const progression = uniqueParagraphs(progressionMemories.map((memory) => memory.content)).join("\n\n");
  const climax = climaxMemory?.content || "";
  const closure = uniqueParagraphs([
    ...afterClimaxMemories.map((memory) => memory.content),
    closureMemory?.memory_id !== climaxMemory?.memory_id ? closureMemory?.content : "",
  ]).join("\n\n");
  const legacy = transformation && !uniqueParagraphs(ordered.map((memory) => memory.content)).join(" ").includes(transformation)
    ? transformation
    : "";

  const narrativeParagraphs = uniqueParagraphs([
    lead,
    progression,
    climax,
    closure,
    legacy,
  ]);

  return {
    title,
    subtitle,
    lead,
    progression,
    climax,
    closure,
    legacy,
    summary: summary || transformation || safeText(closureMemory?.content, ""),
    narrative_content: narrativeParagraphs.join("\n\n"),
    sections: [
      { code: "LEAD", label: "Lead", content: lead, memory_ids: leadMemory ? [leadMemory.memory_id].filter(Boolean) : [] },
      { code: "PROGRESSION", label: "Progressão", content: progression, memory_ids: progressionMemories.map((memory) => memory.memory_id).filter(Boolean) },
      { code: "CLIMAX", label: "Clímax", content: climax, memory_ids: climaxMemory ? [climaxMemory.memory_id].filter(Boolean) : [] },
      { code: "CLOSURE", label: "Encerramento", content: closure, memory_ids: [...afterClimaxMemories, closureMemory].map((memory) => memory?.memory_id).filter(Boolean) },
      { code: "LEGACY", label: "Legado", content: legacy, memory_ids: [] },
    ].filter((section) => section.content),
    used_memories: ordered,
    timeline: asArray(timeline),
    source_policy: "Estrutura materializada exclusivamente com memórias KEEP e transformação aprovada.",
  };
}

export function mergeMaterializedStory({ generated = {}, fallback = {} } = {}) {
  const narrative = safeText(generated?.narrative_content || generated?.content, fallback?.narrative_content || "");
  return {
    ...fallback,
    ...generated,
    title: safeText(generated?.title, fallback?.title || "História descoberta"),
    subtitle: safeText(generated?.subtitle, fallback?.subtitle || ""),
    lead: safeText(generated?.lead, fallback?.lead || ""),
    progression: safeText(generated?.progression, fallback?.progression || ""),
    climax: safeText(generated?.climax, fallback?.climax || ""),
    closure: safeText(generated?.closure, fallback?.closure || ""),
    legacy: safeText(generated?.legacy, fallback?.legacy || ""),
    summary: safeText(generated?.summary, fallback?.summary || ""),
    narrative_content: narrative,
    content: narrative,
    sections: asArray(generated?.sections).length ? generated.sections : asArray(fallback?.sections),
  };
}

export default { materializeStoryStructure, mergeMaterializedStory };
