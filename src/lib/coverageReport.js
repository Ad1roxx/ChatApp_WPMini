/**
 * Pure helpers for editing a coverage-report draft.
 *
 * Every function returns a new draft and leaves its input alone. The server
 * decides what an edit may change (it copies facts and evidence from its own
 * copy), so these only shape what is sent back.
 */

export const VERDICT_LABELS = ['Met', 'Partially met', 'Not found in submission', "Can't assess"];

const mapSection = (draft, sectionId, fn) => ({
  ...draft,
  sections: (draft.sections || []).map((s) => (s.id === sectionId ? fn(s) : s))
});

/** Change fields on one criterion. */
export function editCriterion(draft, sectionId, criterionId, patch) {
  return mapSection(draft, sectionId, (s) => ({
    ...s,
    criteria: (s.criteria || []).map((c) => (c.id === criterionId ? { ...c, ...patch } : c))
  }));
}

/** Edit one item in a list (points, strengths, gaps, lookClosely, notAssessed, trends). */
export function editItem(draft, sectionId, listKey, itemId, patch) {
  const change = (list) => (list || []).map((i) => (i.id === itemId ? { ...i, ...patch } : i));
  if (sectionId == null) return { ...draft, [listKey]: change(draft[listKey]) };
  return mapSection(draft, sectionId, (s) => ({ ...s, [listKey]: change(s[listKey]) }));
}

/** Remove one item from a list. `sectionId` is null for trends. */
export function removeItem(draft, sectionId, listKey, itemId) {
  const drop = (list) => (list || []).filter((i) => i.id !== itemId);
  if (sectionId == null) return { ...draft, [listKey]: drop(draft[listKey]) };
  return mapSection(draft, sectionId, (s) => ({ ...s, [listKey]: drop(s[listKey]) }));
}

let counter = 0;
const newId = () => {
  counter += 1;
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `new-${random}${counter}`;
};

/** Add an empty item to a list, with an id the server will accept as new. */
export function addItem(draft, sectionId, listKey) {
  const item =
    listKey === 'lookClosely'
      ? { id: newId(), where: '', why: '' }
      : { id: newId(), text: '', evidence: [] };
  if (sectionId == null) return { ...draft, [listKey]: [...(draft[listKey] || []), item] };
  return mapSection(draft, sectionId, (s) => ({ ...s, [listKey]: [...(s[listKey] || []), item] }));
}

/** Whether the working draft differs from the saved one. */
export function isDirty(saved, current) {
  return JSON.stringify(saved) !== JSON.stringify(current);
}
