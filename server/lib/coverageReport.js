/**
 * A coverage report's draft: built from the checks, then edited by the mentor
 * (S8 Step 5, AGENT_PLAN §6 S8 (f)). Pure, so both halves are tested alone.
 *
 * `buildReport` makes the draft from facts Express holds (the hand-in's
 * status, lateness and history, the brief) and from each check's result
 * (verdicts, summary points, what was set aside or not read). It calls no
 * model: strengths, gaps, "where to look closely" and trends are derived from
 * the verdicts and their verified evidence, so the report says nothing the
 * checks did not. There is no total, grade or score anywhere.
 *
 * `applyEdits` takes the mentor's edited draft and keeps only what may be
 * edited: wording, a verdict among the four, suggested marks, notes, and
 * removing or adding items. Facts (who, when, the brief, the history) and
 * evidence quotes are always copied from the generated draft, never from the
 * client, so an export cannot show a quote the hand-in does not contain.
 */

const LABELS = ['Met', 'Partially met', 'Not found in submission', "Can't assess"];
const MAX_TEXT = 20000;

const day = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

/** Where a quote is, as one line: "report.pdf, section "Results", page 3". */
function whereText(where) {
  if (!where) return '';
  if (typeof where === 'string') return where;
  const bits = [where.file || "the hand-in's text"];
  if (where.file && where.section) bits.push(`section "${where.section}"`);
  if (where.page) bits.push(`page ${where.page}`);
  return bits.join(', ');
}

const EVENT_WORDS = {
  submitted: 'Handed in',
  unsubmitted: 'Taken back to edit',
  'changes-requested': 'Changes asked for',
  accepted: 'Accepted',
  'draft-saved': 'Draft saved',
  created: 'Set'
};

function submittedLine(submission, assignment, late) {
  if (!submission) return 'No hand-in';
  const when = submission.submittedAt ? `, ${day(submission.submittedAt)}` : '';
  const due = assignment && assignment.dueAt ? ` (due ${day(assignment.dueAt)})` : '';
  const status = { assigned: 'Not handed in', draft: 'Draft, not handed in', submitted: 'Handed in',
    accepted: 'Accepted', 'changes-requested': 'Changes asked for' }[submission.status] || submission.status;
  return `${status}${when}${due}${late ? ', late' : ''}`;
}

function counts(verdicts) {
  const c = Object.fromEntries(LABELS.map((l) => [l, 0]));
  for (const v of verdicts) if (c[v.label] !== undefined) c[v.label] += 1;
  return c;
}

/**
 * @param ctx `{ student, mentor, mentorship, period, items }`; each item is
 *   `{ assignment, submission, late, result, problem }`: `result` is a check's
 *   reply (Step 3/4), `problem` a sentence when it could not run.
 */
function buildReport({ student, mentor, mentorship, period, items }) {
  const sections = items.map((item, si) => {
    const { assignment, submission, late, result, problem } = item;
    const s = {
      id: `s${si + 1}`,
      assignment: assignment.title || 'Assignment',
      mode: result ? result.mode : '',
      modeLabel: result ? result.modeLabel : '',
      checklist: result && result.checklist
        ? `${result.checklist.source.kind === 'rubric' ? `Rubric (${result.checklist.source.fileName})` : 'Checklist from the brief'}, confirmed version ${result.checklist.version}`
        : '',
      status: problem || '',
      brief: assignment.instructions || '',
      submitted: submittedLine(submission, assignment, late),
      files: ((submission && submission.attachments) || []).map((f) => f.name),
      history: ((submission && submission.history) || []).map((e) => `${EVENT_WORDS[e.type] || e.type}, ${day(e.at)}`),
      criteria: [],
      points: [],
      strengths: [],
      gaps: [],
      lookClosely: [],
      notAssessed: []
    };
    if (!result) return s;

    for (const v of result.verdicts || []) {
      const evidence = (v.evidence || []).map((e) => ({ quote: e.quote, where: whereText(e.where) }));
      s.criteria.push({
        id: v.criterionId,
        criterion: v.criterion,
        label: v.label,
        present: v.present || '',
        absent: v.absent || '',
        reason: v.label === "Can't assess" ? v.reasonText || '' : '',
        evidence,
        suggestedMarks: v.suggestedMarks != null && v.maxMarks != null ? `${v.suggestedMarks} of ${v.maxMarks}` : '',
        note: ''
      });
      if (v.label === 'Met') {
        s.strengths.push({ id: `st-${v.criterionId}`, text: v.criterion, evidence: evidence.slice(0, 2) });
      } else if (v.label === 'Partially met') {
        s.gaps.push({ id: `g-${v.criterionId}`, text: `${v.criterion}: ${v.absent || 'only partly shown'}`, evidence: [] });
        for (const e of evidence.slice(0, 1)) {
          s.lookClosely.push({ id: `l-${v.criterionId}`, where: e.where, why: `Partially met: ${v.criterion}` });
        }
      } else if (v.label === 'Not found in submission') {
        s.gaps.push({ id: `g-${v.criterionId}`, text: `${v.criterion}: not found in submission`, evidence: [] });
      } else {
        s.notAssessed.push({ id: `n-${v.criterionId}`, where: v.criterion, reason: v.reasonText || '' });
      }
    }
    for (const [i, p] of (result.points || []).entries()) {
      s.points.push({ id: `p${i + 1}`, point: p.point, evidence: { quote: p.evidence.quote, where: whereText(p.evidence.where) } });
    }
    for (const [i, line] of (result.setAside || []).entries()) {
      s.lookClosely.push({
        id: `sa${i + 1}`,
        where: whereText(line.where),
        why: `A line that may be an instruction to whoever marks the work was set aside, not used as evidence: “${line.quote}”`
      });
    }
    for (const [i, part] of (result.notRead || []).entries()) {
      s.notAssessed.push({ id: `nr${i + 1}`, where: part.where, reason: part.reason });
    }
    return s;
  });

  const trends = [];
  const checked = sections.filter((s) => s.criteria.length);
  for (const s of checked) {
    const c = counts(s.criteria);
    trends.push({ id: `t-${s.id}`, text: `${s.assignment}: ${LABELS.map((l) => `${c[l]} ${l}`).join(', ')}`, evidence: [] });
  }
  const withHandIn = items.filter((i) => i.submission && i.submission.submittedAt);
  if (withHandIn.length) {
    trends.push({ id: 't-late', text: `Handed in late: ${withHandIn.filter((i) => i.late).length} of ${withHandIn.length}`, evidence: [] });
  }

  return {
    title: `Coverage report: ${mentorship.topic || 'mentorship'}`,
    header: {
      student: student.displayName || '',
      mentor: mentor.displayName || '',
      mentorship: mentorship.topic || '',
      period: period ? `${day(period.from)} to ${day(period.to)}` : '',
      assignments: items.map((i) => i.assignment.title || 'Assignment')
    },
    sections,
    trends,
    mentorNotes: ''
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;

function byId(list) {
  return new Map((list || []).map((x) => [x.id, x]));
}

/**
 * Edit a list: keep the order and the items the client sent (removing is
 * allowed), take editable fields from the client and everything else from the
 * generated item. New items (`id` starting "new-") are allowed where
 * `allowNew` builds them; any other unknown id is refused.
 */
function editList(generated, sent, fields, where, allowNew) {
  if (!Array.isArray(sent)) return { error: `${where} must be a list` };
  const known = byId(generated);
  const seen = new Set();
  const out = [];
  for (const item of sent) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) return { error: `${where}: each item needs its own id` };
    seen.add(item.id);
    const base = known.get(item.id);
    if (!base && !(allowNew && item.id.startsWith('new-') && item.id.length <= 100)) {
      return { error: `${where}: ${item.id} is not in this report` };
    }
    const next = base ? { ...base } : allowNew(item.id);
    for (const f of fields) {
      if (item[f] === undefined) continue;
      if (!isText(item[f])) return { error: `${where}: ${f} must be text of at most ${MAX_TEXT} characters` };
      next[f] = item[f];
    }
    out.push(next);
  }
  return { list: out };
}

/** The mentor's edits applied to the generated draft, or `{ error }`. */
function applyEdits(generated, sent) {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return { error: 'Send the edited draft' };
  const draft = { ...generated };
  if (sent.title !== undefined) {
    if (!isText(sent.title, 500) || !sent.title.trim()) return { error: 'The title must be text of at most 500 characters' };
    draft.title = sent.title;
  }
  if (sent.mentorNotes !== undefined) {
    if (!isText(sent.mentorNotes)) return { error: 'Notes must be text of at most 20000 characters' };
    draft.mentorNotes = sent.mentorNotes;
  }
  const trends = editList(generated.trends, sent.trends ?? generated.trends, ['text'], 'Trends', (id) => ({ id, text: '', evidence: [] }));
  if (trends.error) return trends;
  draft.trends = trends.list;

  const sections = byId(generated.sections);
  const sentSections = sent.sections ?? generated.sections;
  if (!Array.isArray(sentSections)) return { error: 'Sections must be a list' };
  draft.sections = [];
  for (const s of sentSections) {
    const base = s && sections.get(s.id);
    if (!base) return { error: `Section ${s && s.id} is not in this report` };
    const next = { ...base };
    const criteria = editList(base.criteria, s.criteria ?? base.criteria,
      ['present', 'absent', 'reason', 'note', 'suggestedMarks'], `${base.assignment}: criteria`);
    if (criteria.error) return criteria;
    for (const [i, c] of (s.criteria ?? base.criteria).entries()) {
      if (c.label === undefined) continue;
      if (!LABELS.includes(c.label)) return { error: `${base.assignment}: a verdict is one of ${LABELS.join(', ')}` };
      criteria.list[i].label = c.label;
    }
    for (const c of criteria.list) {
      if (c.suggestedMarks.length > 100) return { error: 'Suggested marks are at most 100 characters' };
    }
    next.criteria = criteria.list;
    for (const [key, fields, allowNew] of [
      ['points', ['point'], null],
      ['strengths', ['text'], (id) => ({ id, text: '', evidence: [] })],
      ['gaps', ['text'], (id) => ({ id, text: '', evidence: [] })],
      ['lookClosely', ['where', 'why'], (id) => ({ id, where: '', why: '' })],
      ['notAssessed', ['where', 'reason'], null]
    ]) {
      const edited = editList(base[key], s[key] ?? base[key], fields, `${base.assignment}: ${key}`, allowNew);
      if (edited.error) return edited;
      next[key] = edited.list;
    }
    draft.sections.push(next);
  }
  return { draft };
}

module.exports = { buildReport, applyEdits, whereText, LABELS };
