// C:\HDUD_DATA\hdud-api-node\src\services\chapters\chapter-editorial.service.js

import OpenAI from "openai";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "../ai-cost-usage.service.js";
import { getPool, sql } from "../../db.js";

const PROMPT_VERSION = "chapter-editorial-v2";
const MAX_SOURCE_MEMORIES = 40;
const OPENAI_TIMEOUT_MS = 45000;

function nowIso() {
  return new Date().toISOString();
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function uniquePositiveInts(values) {
  const seen = new Set();
  const out = [];

  for (const value of Array.isArray(values) ? values : []) {
    const n = toPositiveInt(value);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }

  return out;
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

function limitText(value, maxLen) {
  const s = cleanText(value, "");
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

function safeJsonParse(value, fallback = null) {
  try {
    if (value == null || value === "") return fallback;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function buildSqlInList(request, prefix, values, type = sql.Int) {
  return values
    .map((value, index) => {
      const key = `${prefix}_${index}`;
      request.input(key, type, value);
      return `@${key}`;
    })
    .join(", ");
}

function normalizeMemoryRow(row, manualOrderMap) {
  const memoryId = Number(row.memory_id);
  const versionContent = cleanText(row.version_content, "");
  const content = cleanText(row.content, "");
  const versionTitle = oneLine(row.version_title, "");
  const title = oneLine(row.title, "");

  return {
    memory_id: memoryId,
    author_id: Number(row.author_id),
    title: versionTitle || title || `Memória ${memoryId}`,
    content: versionContent || content,
    created_at: row.created_at ?? null,
    published_at: row.published_at ?? null,
    publication_status:
      row.publication_status != null ? String(row.publication_status) : null,
    manual_order: manualOrderMap.get(memoryId) ?? 999999,
  };
}

function sortMemoriesForChapter(memories) {
  return [...memories].sort((a, b) => {
    const manualA = Number(a.manual_order ?? 999999);
    const manualB = Number(b.manual_order ?? 999999);
    if (manualA !== manualB) return manualA - manualB;

    const dateA = a.published_at || a.created_at || "";
    const dateB = b.published_at || b.created_at || "";
    const timeA = dateA ? new Date(dateA).getTime() : 0;
    const timeB = dateB ? new Date(dateB).getTime() : 0;
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }

    return Number(a.memory_id) - Number(b.memory_id);
  });
}

function normalizeForMatch(value) {
  return cleanText(value, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sentenceSplit(text) {
  return cleanText(text, "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => cleanText(x, ""))
    .filter(Boolean);
}

function firstUsefulSentence(text, maxLen = 280) {
  const sentences = sentenceSplit(text);
  const sentence =
    sentences.find((s) => s.length >= 25 && s.length <= maxLen + 120) ||
    sentences.find((s) => s.length >= 15) ||
    sentences[0] ||
    cleanText(text, "");
  return limitText(sentence, maxLen);
}

function extractYears(text) {
  const years = [];
  const re = /\b(19\d{2}|20\d{2})\b/g;
  let m;

  while ((m = re.exec(String(text || "")))) {
    const year = Number(m[1]);
    if (
      Number.isInteger(year) &&
      year >= 1900 &&
      year <= 2099 &&
      !years.includes(year)
    ) {
      years.push(year);
    }
  }

  return years.sort((a, b) => a - b);
}

function extractAges(text) {
  const ages = [];
  const re = /\b(\d{1,2})\s+anos?\b/gi;
  let m;

  while ((m = re.exec(String(text || "")))) {
    const age = Number(m[1]);
    if (
      Number.isInteger(age) &&
      age >= 0 &&
      age <= 99 &&
      !ages.includes(age)
    ) {
      ages.push(age);
    }
  }

  return ages;
}

function extractSchoolNames(text) {
  const names = [];
  const raw = String(text || "");

  const patterns = [
    /\bCol[eé]gio\s+([^.,;:!?()\n]{2,90})/gi,
    /\bEscola\s+Municipal\s+([^.,;:!?()\n]{2,90})/gi,
    /\bEscola\s+([^.,;:!?()\n]{2,90})/gi,
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const prefix = match[0].startsWith("Col") ? "Colégio" : match[0].startsWith("Escola Municipal") ? "Escola Municipal" : "Escola";
      const rest = oneLine(match[1], "");
      const candidate = oneLine(`${prefix} ${rest}`, "");
      if (
        candidate &&
        !names.some((x) => normalizeForMatch(x) === normalizeForMatch(candidate))
      ) {
        names.push(candidate);
      }
    }
  }

  return names.slice(0, 8);
}

function detectEditorialTheme(memories) {
  const corpus = normalizeForMatch(
    memories.map((m) => `${m.title || ""}\n${m.content || ""}`).join("\n\n")
  );

  const hasSchool =
    /\bescola\b|\bcolegio\b|\bcolégio\b|\bestudar\b|\bestudei\b|\beducacao\b|\beducação\b|\bserie\b|\bsérie\b|alfabetizacao|alfabetização|pinguinho de gente|maestro franklin/.test(
      corpus
    );
  const hasLove =
    /\bbruna\b|\blapa\b|\bnamoro\b|\bcasamento\b|\bconheci\b|\bamor\b|companheirismo|relacao|relação/.test(
      corpus
    );
  const hasHealth =
    /cirurgia|hernia|hérnia|hospital|dor|fisioterapia|internacao|internação|recuperacao|recuperação|l5|cervical/.test(
      corpus
    );
  const hasHdud =
    /\bhdud\b|historias de um desconhecido|histórias de um desconhecido|startup|memorias|memórias|legado/.test(
      corpus
    );
  const hasWork =
    /\bcbf\b|\breserva\b|\btrabalho\b|\bcarreira\b|\bprojeto\b|\bbanco de dados\b|\bdba\b|sql server|infraestrutura/.test(
      corpus
    );

  if (hasSchool) return "school";
  if (hasLove) return "love";
  if (hasHealth) return "health";
  if (hasHdud) return "hdud";
  if (hasWork) return "work";
  return "generic";
}

function buildGeneratedTitle(memories, explicitTitle = null) {
  const safeExplicit = oneLine(explicitTitle, "");
  if (safeExplicit) return limitText(safeExplicit, 200);

  const theme = detectEditorialTheme(memories);

  if (theme === "school") return "Os Primeiros Passos da Minha Vida Escolar";
  if (theme === "love") {
    const hasBruna = memories.some((m) =>
      /bruna/i.test(`${m.title || ""} ${m.content || ""}`)
    );
    return hasBruna
      ? "O Começo da Minha História com Bruna"
      : "Quando uma História Começou";
  }
  if (theme === "health") return "A Travessia da Reconstrução";
  if (theme === "hdud") return "O Nascimento de uma Ideia";
  if (theme === "work") return "Caminhos de Trabalho e Construção";

  const first = memories[0];
  if (!first) return "Capítulo editorial";

  const firstTitle = oneLine(first.title, "");
  if (memories.length === 1 && firstTitle) return limitText(firstTitle, 200);

  const last = memories[memories.length - 1];
  const lastTitle = oneLine(last?.title, "");

  if (firstTitle && lastTitle && firstTitle !== lastTitle) {
    return limitText(`${firstTitle} — ${lastTitle}`, 200);
  }

  if (firstTitle) return limitText(firstTitle, 200);
  return "Capítulo editorial";
}

function buildGeneratedDescription(memories) {
  const count = memories.length;
  const theme = detectEditorialTheme(memories);

  if (theme === "school") {
    return "Capítulo editorial sobre as primeiras experiências escolares do autor.";
  }
  if (theme === "love") {
    return "Capítulo editorial sobre o início de uma relação importante na vida do autor.";
  }
  if (theme === "health") {
    return "Capítulo editorial sobre um período de dor, recuperação e reconstrução.";
  }
  if (theme === "hdud") {
    return "Capítulo editorial sobre a origem e construção da HDUD.";
  }
  if (theme === "work") {
    return "Capítulo editorial sobre uma etapa de trabalho, responsabilidade e construção profissional.";
  }

  if (count <= 0) {
    return "Capítulo editorial gerado a partir de memórias selecionadas pelo autor.";
  }
  if (count === 1) {
    return "Capítulo editorial gerado a partir de uma memória selecionada pelo autor.";
  }
  return `Capítulo editorial gerado a partir de ${count} memórias selecionadas pelo autor.`;
}

function joinNatural(items) {
  const arr = items.map((x) => oneLine(x, "")).filter(Boolean);
  if (!arr.length) return "";
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} e ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")} e ${arr[arr.length - 1]}`;
}

function lowercaseFirst(text) {
  const s = cleanText(text, "");
  if (!s) return "";
  return `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
}

function buildSchoolEditorialContent(memories, title) {
  const ordered = sortMemoriesForChapter(memories);
  const corpus = ordered.map((m) => `${m.title}\n${m.content}`).join("\n\n");
  const years = extractYears(corpus);
  const ages = extractAges(corpus);
  const schoolNames = extractSchoolNames(corpus);

  const lines = [];
  lines.push(title);
  lines.push("");

  if (years.length === 1) {
    lines.push(`As minhas primeiras lembranças de educação formal começam em ${years[0]}.`);
  } else if (years.length > 1) {
    lines.push(
      `As minhas primeiras lembranças de educação formal remontam aos primeiros anos da década de ${Math.floor(years[0] / 10) * 10}.`
    );
  } else {
    lines.push(
      "As minhas primeiras lembranças de educação formal pertencem aos primeiros anos da minha infância."
    );
  }

  lines.push("");

  const firstMemory = ordered[0];
  const firstText = `${firstMemory?.title || ""}\n${firstMemory?.content || ""}`;
  const firstYears = extractYears(firstText);
  const firstAges = extractAges(firstText);
  const firstYear = firstYears[0] || years[0] || null;
  const firstAge = firstAges[0] || ages[0] || null;
  const firstSchool = schoolNames[0] || oneLine(firstMemory?.title, "a primeira escola");

  if (firstYear && firstAge) {
    lines.push(
      `Em ${firstYear}, eu tinha apenas ${firstAge} anos de idade e começava a viver minhas primeiras experiências fora do ambiente familiar.`
    );
  } else if (firstYear) {
    lines.push(`Em ${firstYear}, comecei a viver uma etapa importante da minha vida escolar.`);
  } else {
    lines.push(
      "Naquele período eu ainda era muito pequeno e começava a descobrir um mundo que existia além do ambiente familiar."
    );
  }

  lines.push("");
  lines.push(
    `Foi no ${firstSchool} que esse início ganhou forma. A escola passou a fazer parte do meu cotidiano, trazendo novas rotinas, novos espaços e os primeiros contatos com a vida escolar.`
  );

  if (ordered.length > 1) {
    const second = ordered[1];
    const secondText = `${second.title}\n${second.content}`;
    const secondYear = extractYears(secondText)[0] || (years.length > 1 ? years[1] : null);
    const secondSchool = schoolNames[1] || oneLine(second.title, "uma nova escola");
    const secondSentence = firstUsefulSentence(second.content, 260);

    lines.push("");
    if (secondYear && firstYear && secondYear !== firstYear) {
      lines.push("No ano seguinte, iniciou-se uma nova etapa.");
    } else {
      lines.push("Depois veio uma nova etapa dessa mesma caminhada.");
    }

    lines.push("");
    lines.push(`Passei a estudar na ${secondSchool}.`);

    if (secondSentence) {
      lines.push("");
      lines.push(secondSentence);
    }
  }

  if (ordered.length > 2) {
    const extraTitles = ordered.slice(2).map((m) => oneLine(m.title, "")).filter(Boolean);
    if (extraTitles.length) {
      lines.push("");
      lines.push(
        `Outras lembranças desse período também se conectam a essa fase inicial, especialmente ${joinNatural(extraTitles)}.`
      );
    }
  }

  lines.push("");
  lines.push(
    "Embora sejam memórias distintas, elas pertencem ao mesmo arco da minha vida: o começo da minha trajetória educacional, os primeiros aprendizados e a adaptação ao universo escolar."
  );
  lines.push("");
  lines.push(
    "Juntas, essas lembranças marcam os primeiros passos de uma caminhada que continuaria pelos anos seguintes."
  );

  return cleanText(lines.join("\n"), "");
}

function buildLoveEditorialContent(memories, title) {
  const ordered = sortMemoriesForChapter(memories);
  const lines = [];

  lines.push(title);
  lines.push("");
  lines.push(
    "Algumas histórias começam em uma noite aparentemente comum, mas só revelam sua importância com o passar do tempo."
  );

  ordered.forEach((memory, index) => {
    const sentence = firstUsefulSentence(memory.content, 340);
    if (!sentence) return;

    lines.push("");

    if (index === 0) {
      lines.push(sentence);
      return;
    }

    if (index === ordered.length - 1) {
      lines.push(`Com o tempo, essa história ganhou outro sentido: ${lowercaseFirst(sentence)}`);
      return;
    }

    lines.push(`Nesse mesmo caminho, outra lembrança se conecta a essa fase: ${lowercaseFirst(sentence)}`);
  });

  lines.push("");
  lines.push(
    "Vistas juntas, essas memórias deixam de ser episódios separados e passam a formar o início de uma relação que ganharia presença, significado e continuidade na minha vida."
  );

  return cleanText(lines.join("\n"), "");
}

function buildHealthEditorialContent(memories, title) {
  const ordered = sortMemoriesForChapter(memories);
  const lines = [];

  lines.push(title);
  lines.push("");
  lines.push(
    "Existem fases da vida que não são atravessadas apenas com força. Elas exigem paciência, medo, esperança e uma reconstrução diária."
  );

  ordered.forEach((memory, index) => {
    const sentence = firstUsefulSentence(memory.content, 340);
    if (!sentence) return;

    lines.push("");

    if (index === 0) {
      lines.push(sentence);
      return;
    }

    lines.push(`Depois, essa travessia continuou em outro momento importante: ${lowercaseFirst(sentence)}`);
  });

  lines.push("");
  lines.push(
    "Essas lembranças, reunidas, formam um capítulo de dor e superação, mas também de permanência: a tentativa de seguir em frente mesmo quando o corpo impõe limites."
  );

  return cleanText(lines.join("\n"), "");
}

function buildHdudEditorialContent(memories, title) {
  const ordered = sortMemoriesForChapter(memories);
  const lines = [];

  lines.push(title);
  lines.push("");
  lines.push(
    "Toda grande ideia nasce de algum ponto real da vida, de uma inquietação que insiste em permanecer mesmo depois que o momento passa."
  );

  ordered.forEach((memory, index) => {
    const sentence = firstUsefulSentence(memory.content, 340);
    if (!sentence) return;

    lines.push("");

    if (index === 0) {
      lines.push(sentence);
      return;
    }

    lines.push(`A partir daí, essa construção ganhou uma nova camada: ${lowercaseFirst(sentence)}`);
  });

  lines.push("");
  lines.push(
    "Essas memórias ajudam a mostrar que a HDUD não surgiu como uma ideia isolada, mas como resposta a uma necessidade humana: preservar histórias reais antes que elas se percam."
  );

  return cleanText(lines.join("\n"), "");
}

function buildWorkEditorialContent(memories, title) {
  const ordered = sortMemoriesForChapter(memories);
  const lines = [];

  lines.push(title);
  lines.push("");
  lines.push(
    "Algumas etapas profissionais não são apenas cargos, projetos ou entregas. Elas se tornam capítulos de formação, responsabilidade e amadurecimento."
  );

  ordered.forEach((memory, index) => {
    const sentence = firstUsefulSentence(memory.content, 340);
    if (!sentence) return;

    lines.push("");

    if (index === 0) {
      lines.push(sentence);
      return;
    }

    lines.push(`Nesse mesmo percurso, outra lembrança revela uma parte dessa construção: ${lowercaseFirst(sentence)}`);
  });

  lines.push("");
  lines.push(
    "Reunidas, essas memórias formam uma linha de trabalho e construção, marcada por responsabilidade, aprendizado e continuidade."
  );

  return cleanText(lines.join("\n"), "");
}

function buildGenericEditorialContent(memories, title) {
  const ordered = sortMemoriesForChapter(memories);
  const lines = [];

  lines.push(title);
  lines.push("");
  lines.push(
    "Algumas memórias, quando vistas juntas, deixam de parecer episódios isolados e passam a revelar uma mesma linha da vida."
  );

  ordered.forEach((memory, index) => {
    const sentence = firstUsefulSentence(memory.content, 340);
    if (!sentence) return;

    lines.push("");

    if (index === 0) {
      lines.push(sentence);
      return;
    }

    if (index === ordered.length - 1) {
      lines.push(`Com o tempo, essa trajetória também passou por outro momento importante: ${lowercaseFirst(sentence)}`);
      return;
    }

    lines.push(`Nesse mesmo percurso, outra lembrança se conecta a essa fase: ${lowercaseFirst(sentence)}`);
  });

  lines.push("");
  lines.push(
    "Essas lembranças, reunidas, ajudam a dar forma a um período específico da minha história. Não são apenas registros separados, mas partes de uma mesma travessia autobiográfica."
  );

  return cleanText(lines.join("\n"), "");
}

function buildDeterministicEditorialContent(memories, title) {
  const theme = detectEditorialTheme(memories);

  if (theme === "school") return buildSchoolEditorialContent(memories, title);
  if (theme === "love") return buildLoveEditorialContent(memories, title);
  if (theme === "health") return buildHealthEditorialContent(memories, title);
  if (theme === "hdud") return buildHdudEditorialContent(memories, title);
  if (theme === "work") return buildWorkEditorialContent(memories, title);

  return buildGenericEditorialContent(memories, title);
}

function buildSourceBlock(memories) {
  return memories
    .map((m, index) => {
      const title = oneLine(m.title, `Memória ${m.memory_id}`);
      const content = cleanText(m.content, "");
      const years = extractYears(`${title}\n${content}`);
      const ages = extractAges(`${title}\n${content}`);
      const meta = [];

      if (years.length) meta.push(`anos citados: ${years.join(", ")}`);
      if (ages.length) meta.push(`idades citadas: ${ages.join(", ")}`);

      return [
        `MEMÓRIA ${index + 1}`,
        `ID: ${m.memory_id}`,
        `TÍTULO: ${title}`,
        meta.length ? `METADADOS EXTRAÍDOS: ${meta.join("; ")}` : null,
        "CONTEÚDO:",
        content || "[Memória sem conteúdo narrativo disponível.]",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

function buildEditorialSystemPrompt() {
  return `Você é um editor autobiográfico profissional da HDUD.

Sua missão é transformar memórias reais do autor em UM CAPÍTULO autobiográfico coeso, fluido e literário.

REGRAS INEGOCIÁVEIS:
- Use somente fatos existentes nas memórias fornecidas.
- Não invente pessoas.
- Não invente eventos.
- Não invente datas.
- Não invente lugares.
- Não invente diálogos.
- Não atribua sentimentos que não estejam sustentados pelo texto.
- Não preencha lacunas factuais.

VOCÊ PODE E DEVE:
- reorganizar cronologicamente quando houver datas explícitas;
- criar transições editoriais entre memórias relacionadas;
- remover redundâncias;
- resumir trechos repetidos;
- conectar fatos do mesmo arco narrativo;
- preservar a voz autobiográfica em primeira pessoa;
- transformar fragmentos em capítulo de livro;
- fazer síntese editorial sem copiar e colar as memórias.

O leitor NÃO deve perceber onde uma memória termina e outra começa.
O resultado NÃO deve ser uma lista de memórias.
O resultado NÃO deve ter separadores, IDs, bullets ou títulos internos de memória.
O resultado deve parecer um capítulo escrito por um editor humano profissional.

Retorne SOMENTE JSON válido neste formato:
{
  "title": "",
  "description": "",
  "content": ""
}`;
}

function buildEditorialUserPrompt({ memories, explicitTitle = null }) {
  const titleHint = explicitTitle
    ? `\nTÍTULO DESEJADO PELO AUTOR: ${oneLine(explicitTitle, "")}\n`
    : "";

  return `${titleHint}
Transforme as memórias abaixo em um capítulo autobiográfico coeso.

IMPORTANTE:
- Não copie as memórias em sequência.
- Não use o título de cada memória como subtítulo.
- Crie uma abertura editorial.
- Crie continuidade entre os fatos.
- Crie fechamento de capítulo.
- Preserve fatos, personagens, datas e lugares apenas quando aparecerem nas fontes.

MEMÓRIAS-FONTE:

${buildSourceBlock(memories)}`;
}

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

function getNarrativeModel() {
  return String(
    process.env.OPENAI_NARRATIVE_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-4.1"
  ).trim();
}

function safeJsonObjectFromText(text) {
  const raw = cleanText(text, "");
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function validateEditorialResult(raw, memories, explicitTitle = null) {
  const fallbackTitle = buildGeneratedTitle(memories, explicitTitle);
  const fallbackDescription = buildGeneratedDescription(memories);

  const title = limitText(oneLine(raw?.title, fallbackTitle), 200) || fallbackTitle;
  const description =
    limitText(oneLine(raw?.description, fallbackDescription), 400) ||
    fallbackDescription;

  let content = cleanText(raw?.content, "");
  if (!content || content.length < 120) {
    content = buildDeterministicEditorialContent(memories, title);
  }

  return {
    title,
    description,
    content,
  };
}

async function withTimeout(promise, timeoutMs, label = "operation") {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} excedeu o tempo limite.`);
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildOpenAIEditorialChapter({ memories, explicitTitle = null, userId = null, authorId = null }) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = getNarrativeModel();

  await assertExternalAIAllowed({ userId, authorId });
  const response = await withTimeout(
    client.chat.completions.create({
      model,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildEditorialSystemPrompt() },
        { role: "user", content: buildEditorialUserPrompt({ memories, explicitTitle }) },
      ],
    }),
    OPENAI_TIMEOUT_MS,
    "Chapter Editorial OpenAI generation"
  );

  const usageRecord = await recordExternalAIUsage({
    userId,
    authorId,
    operationCode: "CHAPTER_EDITORIAL_GENERATION",
    model: response?.model || model,
    ...extractOpenAIUsage(response),
    entityType: "CHAPTER_DRAFT",
    metadata: { source_memory_count: memories.length },
  });

  const text = response?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonObjectFromText(text);
  const result = validateEditorialResult(parsed, memories, explicitTitle);

  return {
    ...result,
    provider: "openai",
    model,
    aiUsageId: usageRecord?.recorded ? Number(usageRecord.usageId) || null : null,
  };
}

async function buildEditorialChapter({ memories, explicitTitle = null, userId = null, authorId = null }) {
  if (hasOpenAIKey()) {
    try {
      return await buildOpenAIEditorialChapter({ memories, explicitTitle, userId, authorId });
    } catch (err) {
      console.warn(
        "Chapter Editorial OpenAI generation failed; using deterministic editor:",
        err?.message
      );
    }
  }

  const title = buildGeneratedTitle(memories, explicitTitle);
  const description = buildGeneratedDescription(memories);
  const content = buildDeterministicEditorialContent(memories, title);

  return {
    title,
    description,
    content,
    provider: "deterministic",
    model: "hdud-chapter-editorial-runtime-v2",
  };
}

function buildSourceSnapshot(memories) {
  return memories.map((m, index) => ({
    order: index + 1,
    memory_id: Number(m.memory_id),
    title: m.title,
    content_preview: limitText(m.content, 360),
    created_at: m.created_at ?? null,
    published_at: m.published_at ?? null,
    publication_status: m.publication_status ?? null,
  }));
}

async function fetchSourceMemories(pool, authorId, memoryIds) {
  const manualOrderMap = new Map(memoryIds.map((id, index) => [Number(id), index + 1]));
  const request = pool.request().input("author_id", sql.Int, authorId);
  const inList = buildSqlInList(request, "memory_id", memoryIds, sql.Int);

  const result = await request.query(`
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
      WHERE mv.memory_id IN (${inList})
    )
    SELECT
      m.memory_id,
      m.author_id,
      m.title,
      m.content,
      m.created_at,
      m.published_at,
      m.publication_status,
      lv.version_title,
      lv.version_content
    FROM dbo.identity_memory m
    LEFT JOIN latest_version lv
      ON lv.memory_id = m.memory_id
     AND lv.rn = 1
    WHERE m.author_id = @author_id
      AND m.memory_id IN (${inList})
      AND ISNULL(m.is_deleted,0) = 0;
  `);

  const rows = result?.recordset || [];
  const memories = rows.map((row) => normalizeMemoryRow(row, manualOrderMap));
  return sortMemoriesForChapter(memories);
}

function assertGenerationTableAvailableError(err) {
  const msg = String(err?.message || "");
  if (msg.includes("identity_chapter_generation") || msg.includes("Invalid object name")) {
    const e = new Error(
      "Tabela dbo.identity_chapter_generation não encontrada. Execute o script SQL 001_create_identity_chapter_generation.sql antes de usar o Chapter Editorial Runtime."
    );
    e.statusCode = 500;
    e.code = "CHAPTER_GENERATION_TABLE_MISSING";
    return e;
  }
  return err;
}

async function insertGeneration(pool, payload) {
  try {
    const result = await pool
      .request()
      .input("author_id", sql.Int, payload.author_id)
      .input("source_memory_ids_json", sql.NVarChar(sql.MAX), JSON.stringify(payload.source_memory_ids))
      .input("source_snapshot_json", sql.NVarChar(sql.MAX), JSON.stringify(payload.source_snapshot))
      .input("generation_type", sql.VarChar(30), "EDITORIAL")
      .input("generation_status", sql.VarChar(30), "GENERATED")
      .input("generated_title", sql.NVarChar(300), payload.generated_title)
      .input("generated_description", sql.NVarChar(800), payload.generated_description)
      .input("generated_content", sql.NVarChar(sql.MAX), payload.generated_content)
      .input("llm_provider", sql.VarChar(100), payload.llm_provider || "deterministic")
      .input("llm_model", sql.VarChar(100), payload.llm_model || "hdud-chapter-editorial-runtime-v2")
      .input("prompt_version", sql.VarChar(50), PROMPT_VERSION)
      .input("ai_usage_id", sql.BigInt, toPositiveInt(payload.ai_usage_id))
      .query(`
        INSERT INTO dbo.identity_chapter_generation
        (
          author_id,
          source_memory_ids_json,
          source_snapshot_json,
          generation_type,
          generation_status,
          generated_title,
          generated_description,
          generated_content,
          llm_provider,
          llm_model,
          prompt_version,
          ai_usage_id,
          created_at
        )
        OUTPUT INSERTED.generation_id
        VALUES
        (
          @author_id,
          @source_memory_ids_json,
          @source_snapshot_json,
          @generation_type,
          @generation_status,
          @generated_title,
          @generated_description,
          @generated_content,
          @llm_provider,
          @llm_model,
          @prompt_version,
          @ai_usage_id,
          SYSUTCDATETIME()
        );
      `);

    return Number(result?.recordset?.[0]?.generation_id ?? 0);
  } catch (err) {
    throw assertGenerationTableAvailableError(err);
  }
}

export async function generateEditorialChapter({ userId = null, authorId, memoryIds, title = null }) {
  const safeAuthorId = toPositiveInt(authorId);
  if (!safeAuthorId) {
    const err = new Error("author_id inválido.");
    err.statusCode = 401;
    throw err;
  }

  const safeMemoryIds = uniquePositiveInts(memoryIds);
  if (!safeMemoryIds.length) {
    const err = new Error("memory_ids é obrigatório.");
    err.statusCode = 400;
    throw err;
  }

  if (safeMemoryIds.length > MAX_SOURCE_MEMORIES) {
    const err = new Error(`Selecione no máximo ${MAX_SOURCE_MEMORIES} memórias por geração.`);
    err.statusCode = 400;
    throw err;
  }

  const pool = await getPool();
  const memories = await fetchSourceMemories(pool, safeAuthorId, safeMemoryIds);

  if (memories.length !== safeMemoryIds.length) {
    const found = new Set(memories.map((m) => Number(m.memory_id)));
    const missing = safeMemoryIds.filter((id) => !found.has(Number(id)));
    const err = new Error("Uma ou mais memórias não existem, foram removidas ou não pertencem ao autor.");
    err.statusCode = 404;
    err.code = "SOURCE_MEMORY_NOT_FOUND";
    err.details = { missing_memory_ids: missing };
    throw err;
  }

  const editorial = await buildEditorialChapter({ memories, explicitTitle: title, userId, authorId });
  const generatedTitle = editorial.title;
  const generatedDescription = editorial.description;
  const generatedContent = editorial.content;
  const sourceSnapshot = buildSourceSnapshot(memories);

  const generationId = await insertGeneration(pool, {
    author_id: safeAuthorId,
    source_memory_ids: memories.map((m) => Number(m.memory_id)),
    source_snapshot: sourceSnapshot,
    generated_title: generatedTitle,
    generated_description: generatedDescription,
    generated_content: generatedContent,
    llm_provider: editorial.provider,
    llm_model: editorial.model,
    ai_usage_id: editorial.aiUsageId ?? null,
  });

  return {
    ok: true,
    generation_id: generationId,
    generation_status: "GENERATED",
    generation_type: "EDITORIAL",
    ai_usage_id: editorial.aiUsageId ?? null,
    generated_title: generatedTitle,
    generated_description: generatedDescription,
    generated_content: generatedContent,
    source_memory_count: memories.length,
    source_memory_ids: memories.map((m) => Number(m.memory_id)),
    source_snapshot: sourceSnapshot,
    meta: {
      provider: editorial.provider,
      model: editorial.model,
      prompt_version: PROMPT_VERSION,
      generated_at: nowIso(),
      rules: [
        "no_fake_content",
        "no_synthetic_events",
        "no_dialogue_creation",
        "source_memories_only",
        "editorial_synthesis",
      ],
    },
  };
}

export async function getEditorialGeneration({ authorId, generationId }) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeGenerationId = toPositiveInt(generationId);

  if (!safeAuthorId || !safeGenerationId) {
    const err = new Error("generation_id inválido.");
    err.statusCode = 400;
    throw err;
  }

  const pool = await getPool();

  try {
    const result = await pool
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("generation_id", sql.BigInt, safeGenerationId)
      .query(`
        SELECT TOP 1
          generation_id,
          chapter_id,
          chapter_version_id,
          author_id,
          source_memory_ids_json,
          source_snapshot_json,
          generation_type,
          generation_status,
          generated_title,
          generated_description,
          generated_content,
          approved_title,
          approved_description,
          approved_content,
          llm_provider,
          llm_model,
          prompt_version,
          created_at,
          approved_at
        FROM dbo.identity_chapter_generation
        WHERE generation_id = @generation_id
          AND author_id = @author_id;
      `);

    const row = result?.recordset?.[0] || null;
    if (!row) {
      const err = new Error("Geração editorial não encontrada.");
      err.statusCode = 404;
      throw err;
    }

    return {
      ok: true,
      generation_id: Number(row.generation_id),
      chapter_id: row.chapter_id != null ? Number(row.chapter_id) : null,
      chapter_version_id:
        row.chapter_version_id != null ? Number(row.chapter_version_id) : null,
      generation_type: row.generation_type,
      generation_status: row.generation_status,
      generated_title: row.generated_title ?? null,
      generated_description: row.generated_description ?? null,
      generated_content: row.generated_content ?? "",
      approved_title: row.approved_title ?? null,
      approved_description: row.approved_description ?? null,
      approved_content: row.approved_content ?? null,
      source_memory_ids: safeJsonParse(row.source_memory_ids_json, []),
      source_snapshot: safeJsonParse(row.source_snapshot_json, []),
      meta: {
        provider: row.llm_provider ?? null,
        model: row.llm_model ?? null,
        prompt_version: row.prompt_version ?? null,
        created_at: row.created_at ?? null,
        approved_at: row.approved_at ?? null,
      },
    };
  } catch (err) {
    throw assertGenerationTableAvailableError(err);
  }
}

async function linkMemoriesToChapter(transaction, authorId, chapterId, memoryIds) {
  let sortOrder = 1;

  for (const memoryId of memoryIds) {
    await new sql.Request(transaction)
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .input("sort_order", sql.Int, sortOrder)
      .query(`
        IF NOT EXISTS (
          SELECT 1
          FROM dbo.identity_memory_chapter
          WHERE author_id = @author_id
            AND chapter_id = @chapter_id
            AND memory_id = @memory_id
        )
        BEGIN
          INSERT INTO dbo.identity_memory_chapter
          (
            author_id,
            chapter_id,
            memory_id,
            is_primary,
            sort_order,
            created_at,
            created_by
          )
          VALUES
          (
            @author_id,
            @chapter_id,
            @memory_id,
            0,
            @sort_order,
            SYSUTCDATETIME(),
            N'chapter-editorial-runtime-v2'
          );
        END
        ELSE
        BEGIN
          UPDATE dbo.identity_memory_chapter
          SET sort_order = COALESCE(sort_order, @sort_order)
          WHERE author_id = @author_id
            AND chapter_id = @chapter_id
            AND memory_id = @memory_id;
        END
      `);

    sortOrder += 1;
  }
}

export async function approveEditorialGeneration({
  authorId,
  generationId,
  title = null,
  description = null,
  content = null,
}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeGenerationId = toPositiveInt(generationId);

  if (!safeAuthorId || !safeGenerationId) {
    const err = new Error("generation_id inválido.");
    err.statusCode = 400;
    throw err;
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const generationResult = await new sql.Request(tx)
      .input("author_id", sql.Int, safeAuthorId)
      .input("generation_id", sql.BigInt, safeGenerationId)
      .query(`
        SELECT TOP 1
          generation_id,
          chapter_id,
          chapter_version_id,
          author_id,
          source_memory_ids_json,
          generation_status,
          generated_title,
          generated_description,
          generated_content
        FROM dbo.identity_chapter_generation WITH (UPDLOCK, HOLDLOCK)
        WHERE generation_id = @generation_id
          AND author_id = @author_id;
      `);

    const generation = generationResult?.recordset?.[0] || null;
    if (!generation) {
      const err = new Error("Geração editorial não encontrada.");
      err.statusCode = 404;
      throw err;
    }

    if (String(generation.generation_status || "").toUpperCase() === "APPROVED") {
      await tx.commit();
      return {
        ok: true,
        approved: false,
        already_approved: true,
        generation_id: Number(generation.generation_id),
        chapter_id: generation.chapter_id != null ? Number(generation.chapter_id) : null,
        chapter_version_id:
          generation.chapter_version_id != null ? Number(generation.chapter_version_id) : null,
      };
    }

    const approvedTitle = limitText(
      oneLine(title, generation.generated_title || "Capítulo editorial"),
      200
    );
    const approvedDescription = limitText(
      oneLine(description, generation.generated_description || "Capítulo editorial aprovado pelo autor."),
      400
    );
    const approvedContent = cleanText(content, generation.generated_content || "");

    if (!approvedTitle) {
      const err = new Error("Título aprovado é obrigatório.");
      err.statusCode = 400;
      throw err;
    }

    if (!approvedContent) {
      const err = new Error("Conteúdo aprovado é obrigatório.");
      err.statusCode = 400;
      throw err;
    }

    const createResult = await new sql.Request(tx)
      .input("author_id", sql.Int, safeAuthorId)
      .input("title", sql.NVarChar(200), approvedTitle)
      .input("description", sql.NVarChar(400), approvedDescription)
      .input("body", sql.NVarChar(sql.MAX), approvedContent)
      .input("status", sql.VarChar(20), "DRAFT")
      .output("chapter_id", sql.Int)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Create_WithVersion");

    const createdRow = createResult?.recordset?.[0] || null;
    const chapterId = Number(createResult?.output?.chapter_id ?? createdRow?.chapter_id ?? 0);
    const chapterVersionId = Number(
      createResult?.output?.chapter_version_id ?? createdRow?.chapter_version_id ?? 0
    );

    if (!chapterId || !chapterVersionId) {
      const err = new Error("Falha ao criar capítulo a partir da geração editorial.");
      err.statusCode = 500;
      throw err;
    }

    const sourceMemoryIds = uniquePositiveInts(
      safeJsonParse(generation.source_memory_ids_json, [])
    );
    await linkMemoriesToChapter(tx, safeAuthorId, chapterId, sourceMemoryIds);

    await new sql.Request(tx)
      .input("author_id", sql.Int, safeAuthorId)
      .input("generation_id", sql.BigInt, safeGenerationId)
      .input("chapter_id", sql.Int, chapterId)
      .input("chapter_version_id", sql.Int, chapterVersionId)
      .input("approved_title", sql.NVarChar(300), approvedTitle)
      .input("approved_description", sql.NVarChar(800), approvedDescription)
      .input("approved_content", sql.NVarChar(sql.MAX), approvedContent)
      .query(`
        UPDATE dbo.identity_chapter_generation
        SET
          chapter_id = @chapter_id,
          chapter_version_id = @chapter_version_id,
          generation_status = 'APPROVED',
          approved_title = @approved_title,
          approved_description = @approved_description,
          approved_content = @approved_content,
          approved_at = SYSUTCDATETIME()
        WHERE generation_id = @generation_id
          AND author_id = @author_id;
      `);

    await tx.commit();

    return {
      ok: true,
      approved: true,
      generation_id: safeGenerationId,
      chapter_id: chapterId,
      chapter_version_id: chapterVersionId,
      title: approvedTitle,
      description: approvedDescription,
      linked_memory_ids: sourceMemoryIds,
    };
  } catch (err) {
    try {
      if (tx._aborted !== true) await tx.rollback();
    } catch {}
    throw assertGenerationTableAvailableError(err);
  }
}
