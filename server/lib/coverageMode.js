/**
 * Which of S8's three modes a check runs in (AGENT_PLAN §6 S8, "Three modes").
 * Pure, so the rule is tested on its own.
 *
 * - **rubric**: the brief has a file marked as the rubric.
 * - **brief**: no rubric, and the brief's own extracted checklist has at least
 *   N checkable items. Assessed against that checklist, confirmed like a
 *   rubric's, and labelled as such.
 * - **summary**: no rubric, and fewer than N. A cited summary: no verdicts,
 *   no marks.
 *
 * N is 3, fixed before measuring (the human, S8 Step 0; s8-threshold.txt).
 * The count is of the criteria extraction kept from the brief, not of its
 * verbs. The mentor can always choose the mode instead, within what exists:
 * rubric mode needs a rubric, brief mode a checklist read from the brief.
 */

const N = 3;

const LABELS = {
  rubric: 'Assessed against the rubric',
  brief: 'Assessed against the assignment brief; no rubric was provided',
  summary: 'Summary only: no rubric was provided and the brief sets too few checkable requirements, so nothing is marked'
};

/**
 * @param rubricMarked whether a brief file is marked as the rubric
 * @param briefCount criteria extracted from the brief, or null if it has not been read
 * @param override the mode the mentor chose, if any
 * @returns `{ mode, chosenBy, label }`, `{ needsBrief: true }` when the brief
 *   must be read first, or `{ error }` for an override that cannot apply
 */
function chooseMode({ rubricMarked, briefCount, override }) {
  if (override !== undefined && override !== null) {
    if (!Object.hasOwn(LABELS, override)) return { error: 'Choose rubric, brief or summary' };
    if (override === 'rubric' && !rubricMarked) return { error: 'Mark one of the brief\'s files as the rubric first' };
    if (override === 'brief' && !(briefCount > 0)) return { error: 'Read a checklist from the brief first' };
    return { mode: override, chosenBy: 'mentor', label: LABELS[override] };
  }
  if (rubricMarked) return { mode: 'rubric', chosenBy: 'rule', label: LABELS.rubric };
  if (briefCount === null || briefCount === undefined) return { needsBrief: true };
  const mode = briefCount >= N ? 'brief' : 'summary';
  return { mode, chosenBy: 'rule', label: LABELS[mode] };
}

module.exports = { chooseMode, N, LABELS };
