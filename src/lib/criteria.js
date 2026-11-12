/**
 * Pure helpers for the rubric-criteria confirmation screen
 * (src/components/CriteriaPanel.jsx), testable without a browser.
 *
 * A row is what the mentor edits: `{ key, text, from, sourceText, marks, weight }`.
 * Only text, from, marks and weight go to the server (see `toConfirmBody`).
 */

export const MAX_ROWS = 40;

let counter = 0;
const newKey = () => `r${++counter}`;

export function rowsFrom(set, { fromExtraction = false } = {}) {
  // `latest` is the newest version object itself (or null).
  const version = fromExtraction ? null : set?.latest || null;

  if (version) {
    return version.criteria.map((k) => ({
      key: newKey(),
      text: k.text,
      from: [k.id],
      sourceText: k.sourceText ?? '',
      marks: k.marks ?? null,
      weight: k.weight ?? null
    }));
  }
  return (set?.extracted?.criteria || []).map((c) => ({
    key: newKey(),
    text: c.sourceText,
    from: [c.id],
    sourceText: c.sourceText,
    marks: c.marks ?? null,
    weight: c.weight ?? null
  }));
}

const sumOrNull = (values) =>
  values.every((v) => typeof v === 'number') ? values.reduce((a, b) => a + b, 0) : null;

export function mergeRows(rows, keys) {
  const chosen = rows.filter((r) => keys.includes(r.key));
  if (chosen.length < 2) return rows;
  const merged = {
    key: newKey(),
    text: chosen.map((r) => r.text).join(' / '),
    from: chosen.flatMap((r) => r.from),
    sourceText: chosen.map((r) => r.sourceText).join('\n…\n'),
    marks: sumOrNull(chosen.map((r) => r.marks)),
    weight: sumOrNull(chosen.map((r) => r.weight))
  };
  const out = [];
  let placed = false;
  for (const r of rows) {
    if (!keys.includes(r.key)) out.push(r);
    else if (!placed) {
      out.push(merged);
      placed = true;
    }
  }
  return out;
}

export function addRow(rows) {
  return [
    ...rows,
    { key: newKey(), text: '', from: [], sourceText: '', marks: null, weight: null }
  ];
}

export const removeRow = (rows, key) => rows.filter((r) => r.key !== key);

export const updateRow = (rows, key, patch) =>
  rows.map((r) => (r.key === key ? { ...r, ...patch } : r));

export function toConfirmBody(rows) {
  return {
    criteria: rows.map((r) => ({
      text: r.text.trim(),
      from: r.from,
      marks: r.marks ?? null,
      weight: r.weight ?? null
    }))
  };
}

export function problemWith(rows) {
  if (rows.length > MAX_ROWS) return `Up to ${MAX_ROWS} criteria`;
  if (rows.some((r) => r.text.trim() === '')) return 'Every criterion needs some wording';
  return null;
}
