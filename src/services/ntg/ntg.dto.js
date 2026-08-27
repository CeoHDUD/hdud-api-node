function firstDefined(row, keys, fallback = null) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
  }
  return fallback;
}

function cleanString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const result = String(value).trim();
  return result || fallback;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function nullableBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
}

export function normalizeLocale(value) {
  return cleanString(value, "pt-BR").slice(0, 20);
}

export function normalizeCode(value) {
  const code = cleanString(value, null);
  return code ? code.toUpperCase().slice(0, 120) : null;
}

export function toTaxonomyNodeDto(row, fallbackLocale = "pt-BR") {
  const domain = normalizeCode(firstDefined(row, ["domain", "taxonomy_domain", "node_domain"]));
  const code = normalizeCode(firstDefined(row, [
    "code",
    "taxonomy_code",
    "node_code",
    "target_code",
    "context_code",
    "life_period_code",
    "narrative_role_code",
  ]));

  return {
    id: nullableNumber(firstDefined(row, ["taxonomy_id", "node_id", "id", "target_taxonomy_id"])),
    domain,
    code,
    label: cleanString(firstDefined(row, ["label", "node_label", "target_label", "name"]), code),
    description: cleanString(firstDefined(row, ["description", "node_description", "target_description"])),
    locale: cleanString(firstDefined(row, ["locale", "resolved_locale"]), fallbackLocale),
    sort_order: nullableNumber(firstDefined(row, ["sort_order", "node_sort_order", "target_sort_order"], 0)) ?? 0,
    relationship: normalizeCode(firstDefined(row, ["relationship", "relationship_type", "edge_type", "relation_type"])),
    weight: nullableNumber(firstDefined(row, ["weight", "edge_weight", "score", "relevance_score"])),
    is_active: nullableBoolean(firstDefined(row, ["is_active", "active"])),
  };
}

export function toNodeListDto(rows, fallbackLocale = "pt-BR") {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => toTaxonomyNodeDto(row, fallbackLocale))
    .filter((item) => item.code)
    .sort((a, b) => {
      const order = (a.sort_order ?? 0) - (b.sort_order ?? 0);
      if (order !== 0) return order;
      return String(a.label || a.code).localeCompare(String(b.label || b.code), fallbackLocale);
    });
}

export function toPathDto(recordsets, fallbackLocale = "pt-BR") {
  const sets = Array.isArray(recordsets) ? recordsets : [];
  const primaryRows = Array.isArray(sets[0]) ? sets[0] : [];
  const secondaryRows = Array.isArray(sets[1]) ? sets[1] : [];

  const steps = primaryRows.map((row, index) => ({
    position: nullableNumber(firstDefined(row, ["position", "step", "step_number", "path_order"])) ?? index + 1,
    ...toTaxonomyNodeDto(row, fallbackLocale),
    source_code: normalizeCode(firstDefined(row, ["source_code", "from_code"])),
    target_code: normalizeCode(firstDefined(row, ["target_code", "to_code"])),
  }));

  const edges = secondaryRows.map((row, index) => ({
    position: nullableNumber(firstDefined(row, ["position", "step", "step_number", "path_order"])) ?? index + 1,
    source_code: normalizeCode(firstDefined(row, ["source_code", "from_code"])),
    target_code: normalizeCode(firstDefined(row, ["target_code", "to_code"])),
    relationship: normalizeCode(firstDefined(row, ["relationship", "relationship_type", "edge_type", "relation_type"])),
    weight: nullableNumber(firstDefined(row, ["weight", "edge_weight", "score"])),
  }));

  return {
    found: steps.length > 0 || edges.length > 0,
    steps,
    edges,
  };
}
