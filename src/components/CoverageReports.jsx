/**
 * CoverageReports — the mentor's draft reports on one mentorship.
 *
 * Mentor only: the page does not render this for anyone else, and the server
 * refuses everyone but the mentorship's mentor in any case. A report is a
 * draft of suggestions. Nothing here sends anything to the student.
 *
 * Everything the server or the model wrote is shown as text (React escapes it);
 * nothing is ever inserted as HTML. The server decides which edits count.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Button from './Button';
import Card from './Card';
import { Input, Select, Textarea } from './Field';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import { saveBlob } from '../lib/attachments';
import {
  VERDICT_LABELS,
  addItem,
  editCriterion,
  editItem,
  isDirty,
  removeItem
} from '../lib/coverageReport';
import styles from './CoverageReports.module.css';

const MODES = [
  ['', 'Choose automatically'],
  ['rubric', 'Rubric'],
  ['brief', 'Assignment brief'],
  ['summary', 'Summary only']
];

const CRITERION_TEXT = [
  ['present', 'Present'],
  ['absent', 'Absent'],
  ['reason', 'Reason'],
  ['note', 'Note']
];

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

function Evidence({ list }) {
  const items = (list || []).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <ul className={styles.evidence}>
      {items.map((e, i) => (
        <li key={i}>
          <blockquote className={styles.quote}>{e.quote}</blockquote>
          <span className={styles.where}>{e.where}</span>
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, value }) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  return (
    <p className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>{' '}
      {Array.isArray(value) ? value.join(', ') : value}
    </p>
  );
}

/** An editable, removable list of items, each with the text fields named in `fields`. */
function ItemList({ title, items, fields, onEdit, onRemove, onAdd, addLabel, showEvidence }) {
  return (
    <div className={styles.block}>
      <h4 className={styles.blockTitle}>{title}</h4>
      {items.length === 0 && <p className={styles.hint}>None.</p>}
      <ul className={styles.items}>
        {items.map((item) => (
          <li key={item.id} className={styles.item}>
            <div className={styles.itemFields}>
              {fields.map(([key, label]) => (
                <Textarea
                  key={key}
                  rows={2}
                  aria-label={`${title}: ${label}`}
                  value={item[key] || ''}
                  onChange={(e) => onEdit(item.id, { [key]: e.target.value })}
                />
              ))}
              {showEvidence && <Evidence list={item.evidence} />}
            </div>
            <Button size="sm" variant="ghost" onClick={() => onRemove(item.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {onAdd && (
        <Button size="sm" onClick={onAdd}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}

function Section({ section, setDraft }) {
  const sid = section.id;
  const list = (key, title, fields, opts = {}) => (
    <ItemList
      title={title}
      items={section[key] || []}
      fields={fields}
      showEvidence={opts.evidence}
      onEdit={(id, patch) => setDraft((d) => editItem(d, sid, key, id, patch))}
      onRemove={(id) => setDraft((d) => removeItem(d, sid, key, id))}
      onAdd={opts.addLabel ? () => setDraft((d) => addItem(d, sid, key)) : undefined}
      addLabel={opts.addLabel}
    />
  );

  return (
    <section className={styles.section} aria-label={`Assignment: ${section.assignment}`}>
      <h3 className={styles.sectionTitle}>{section.assignment}</h3>
      <Fact label="How it was assessed:" value={section.modeLabel} />
      <Fact label="Checklist:" value={section.checklist} />
      <Fact label="Status:" value={section.status} />
      <Fact label="Brief:" value={section.brief} />
      <Fact label="Submitted:" value={section.submitted} />
      <Fact label="Files:" value={section.files} />
      <Fact label="History:" value={section.history} />

      {(section.criteria || []).length > 0 && (
        <div className={styles.block}>
          <h4 className={styles.blockTitle}>Criteria</h4>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Suggested verdict</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {section.criteria.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.criterion}</strong>
                    <Evidence list={c.evidence} />
                  </td>
                  <td>
                    <Select
                      aria-label={`Verdict: ${c.criterion}`}
                      value={c.label}
                      onChange={(e) =>
                        setDraft((d) => editCriterion(d, sid, c.id, { label: e.target.value }))
                      }
                    >
                      {VERDICT_LABELS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </Select>
                    <Input
                      aria-label={`Suggested marks: ${c.criterion}`}
                      placeholder="Suggested marks"
                      value={c.suggestedMarks || ''}
                      onChange={(e) =>
                        setDraft((d) =>
                          editCriterion(d, sid, c.id, { suggestedMarks: e.target.value })
                        )
                      }
                    />
                  </td>
                  <td className={styles.details}>
                    {CRITERION_TEXT.map(([key, label]) => (
                      <label key={key} className={styles.labelled}>
                        <span>{label}</span>
                        <Textarea
                          rows={2}
                          aria-label={`${label}: ${c.criterion}`}
                          value={c[key] || ''}
                          onChange={(e) =>
                            setDraft((d) => editCriterion(d, sid, c.id, { [key]: e.target.value }))
                          }
                        />
                      </label>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(section.points || []).length > 0 && (
        <div className={styles.block}>
          <h4 className={styles.blockTitle}>Summary points</h4>
          <ul className={styles.items}>
            {section.points.map((p) => (
              <li key={p.id} className={styles.item}>
                <div className={styles.itemFields}>
                  <Textarea
                    rows={2}
                    aria-label="Summary point"
                    value={p.point || ''}
                    onChange={(e) =>
                      setDraft((d) => editItem(d, sid, 'points', p.id, { point: e.target.value }))
                    }
                  />
                  <Evidence list={p.evidence ? [p.evidence] : []} />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft((d) => removeItem(d, sid, 'points', p.id))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {list('strengths', 'Strengths', [['text', 'Text']], {
        evidence: true,
        addLabel: 'Add a strength'
      })}
      {list('gaps', 'Gaps', [['text', 'Text']], { evidence: true, addLabel: 'Add a gap' })}
      {list(
        'lookClosely',
        'Where to look closely',
        [
          ['where', 'Where'],
          ['why', 'Why']
        ],
        { addLabel: 'Add a place to look' }
      )}
      {list('notAssessed', 'What could not be assessed', [
        ['where', 'Where'],
        ['reason', 'Reason']
      ])}
    </section>
  );
}

export default function CoverageReports({ mentorshipId }) {
  const { authFetch } = useAuth();
  const toast = useToast();

  const [rows, setRows] = useState([]);
  const [reports, setReports] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [mode, setMode] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [view, setView] = useState(null); // the report as the server last sent it
  const [draft, setDraft] = useState(null); // the working copy
  const [lastIds, setLastIds] = useState(null);
  const [busy, setBusy] = useState(false);

  const assignments = useMemo(() => {
    const seen = new Map();
    for (const r of rows) {
      const a = r && typeof r.assignment === 'object' ? r.assignment : null;
      if (a?._id && !seen.has(a._id)) seen.set(a._id, a);
    }
    return [...seen.values()];
  }, [rows]);

  const fail = useCallback(
    async (res, fallback) => {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || fallback);
    },
    [toast]
  );

  const loadList = useCallback(async () => {
    try {
      const res = await authFetch(`/api/mentorships/${mentorshipId}/coverage-reports`);
      if (res.ok) {
        setReports((await res.json()).reports || []);
      } else {
        setReports([]);
        await fail(res, 'Could not load the reports');
      }
    } catch (err) {
      console.error('Error loading coverage reports:', err.name);
      setReports([]);
    }
  }, [authFetch, mentorshipId, fail]);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const res = await authFetch(`/api/mentorships/${mentorshipId}/assignments`);
        if (res.ok && !stale) setRows(await res.json());
      } catch (err) {
        console.error('Error loading assignments for reports:', err.name);
      }
      await loadList();
    })();
    return () => {
      stale = true;
    };
  }, [authFetch, mentorshipId, loadList]);

  const show = (report) => {
    setView(report);
    setDraft(report.draft);
  };

  const draftReport = async ({ ids, forceMode }) => {
    setDrafting(true);
    try {
      const body = {};
      if (ids.length > 0) body.assignmentIds = ids;
      const chosen = forceMode ?? mode;
      if (chosen) body.mode = chosen;
      const res = await authFetch(`/api/mentorships/${mentorshipId}/coverage-reports`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (res.ok) {
        setLastIds(ids);
        show(await res.json());
        loadList();
      } else {
        await fail(res, 'Could not draft the report');
      }
    } catch (err) {
      console.error('Error drafting coverage report:', err.name);
      toast.error('Could not reach the server');
    } finally {
      setDrafting(false);
    }
  };

  const openReport = async (id) => {
    try {
      const res = await authFetch(`/api/coverage-reports/${id}`);
      if (res.ok) {
        setLastIds(null);
        show(await res.json());
      } else {
        await fail(res, 'Could not open that report');
      }
    } catch (err) {
      console.error('Error opening coverage report:', err.name);
      toast.error('Could not reach the server');
    }
  };

  const call = async (path, method, body, then, failure) => {
    setBusy(true);
    try {
      const res = await authFetch(path, { method, body: JSON.stringify(body) });
      if (res.ok) await then(res);
      else await fail(res, failure);
    } catch (err) {
      console.error('Error with coverage report:', err.name);
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const dirty = view && draft ? isDirty(view.draft, draft) : false;

  const save = () =>
    call(
      `/api/coverage-reports/${view.id}`,
      'PATCH',
      { draft },
      async (res) => {
        show(await res.json());
        loadList();
        toast.success('Draft saved');
      },
      'Could not save the draft'
    );

  const review = (reviewed) =>
    call(
      `/api/coverage-reports/${view.id}/review`,
      'POST',
      { reviewed },
      async (res) => {
        setView(await res.json());
        loadList();
      },
      'Could not change the review'
    );

  const exportAs = (format) =>
    call(
      `/api/coverage-reports/${view.id}/export`,
      'POST',
      { format },
      async (res) => {
        saveBlob(await res.blob(), `coverage-report.${format === 'pdf' ? 'pdf' : 'docx'}`);
        loadList();
      },
      'Could not export the report'
    );

  // The same assignments as this report, by the ids the server stored with it.
  const redoInRubric = () => draftReport({ ids: view.assignments || lastIds || [], forceMode: 'rubric' });

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reviewed = Boolean(view?.reviewedAt);
  const sections = draft?.sections || [];
  const needsRubric = sections.some((s) => s.mode && s.mode !== 'rubric');

  return (
    <Card
      title="Coverage reports"
      subtitle="Draft a report on a student's work, check it, and export it."
    >
      <div className={styles.form}>
        <h3 className={styles.blockTitle}>Draft a report</h3>
        {assignments.length === 0 ? (
          <p className={styles.hint}>No assignments have been set in this mentorship yet.</p>
        ) : (
          <fieldset className={styles.fieldset}>
            <legend className={styles.hint}>Leave all unticked to include every assignment.</legend>
            {assignments.map((a) => (
              <label key={a._id} className={styles.check}>
                <input type="checkbox" checked={picked.has(a._id)} onChange={() => toggle(a._id)} />
                <span>{a.title}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className={styles.labelled}>
          <span>How to assess</span>
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <div>
          <Button
            variant="primary"
            loading={drafting}
            disabled={drafting}
            onClick={() => draftReport({ ids: [...picked] })}
          >
            Draft a report
          </Button>
          {drafting && (
            <span className={styles.hint} role="status">
              {' '}
              Drafting the report…
            </span>
          )}
        </div>
      </div>

      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Drafts</h3>
        {reports === null ? (
          <InlineLoader label="Loading reports" />
        ) : reports.length === 0 ? (
          <p className={styles.hint}>No drafts yet.</p>
        ) : (
          <ul className={styles.items}>
            {reports.map((r) => {
              const n = (r.assignments || []).length;
              return (
                <li key={r.id} className={styles.listRow}>
                  <span>
                    {fmtDate(r.createdAt)} · {n} {n === 1 ? 'assignment' : 'assignments'} ·{' '}
                    {r.reviewedAt ? 'Reviewed' : 'Not reviewed'}
                    {(r.exports || []).length > 0 &&
                      ` · Exported ${r.exports.map((x) => x.format).join(', ')}`}
                  </span>
                  <Button size="sm" onClick={() => openReport(r.id)}>
                    Open
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {view && draft && (
        <div className={styles.editor}>
          <p className={styles.banner}>
            Draft, reviewed by the mentor. Suggestions for you to confirm; never sent to the
            student.
          </p>

          <label className={styles.labelled}>
            <span>Title</span>
            <Input
              aria-label="Report title"
              value={draft.title || ''}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </label>
          <Fact label="Student:" value={draft.header?.student} />
          <Fact label="Mentor:" value={draft.header?.mentor} />
          <Fact label="Mentorship:" value={draft.header?.mentorship} />
          <Fact label="Period:" value={draft.header?.period} />
          <Fact label="Assignments:" value={draft.header?.assignments} />

          {sections.map((s) => (
            <Section key={s.id} section={s} setDraft={setDraft} />
          ))}

          <ItemList
            title="Trends"
            items={draft.trends || []}
            fields={[['text', 'Text']]}
            showEvidence
            onEdit={(id, patch) => setDraft((d) => editItem(d, null, 'trends', id, patch))}
            onRemove={(id) => setDraft((d) => removeItem(d, null, 'trends', id))}
            onAdd={() => setDraft((d) => addItem(d, null, 'trends'))}
            addLabel="Add a trend"
          />

          <label className={styles.labelled}>
            <span>Mentor&apos;s notes</span>
            <Textarea
              rows={4}
              aria-label="Mentor's notes"
              value={draft.mentorNotes || ''}
              onChange={(e) => setDraft((d) => ({ ...d, mentorNotes: e.target.value }))}
            />
          </label>

          <div className={styles.actions}>
            <Button variant="primary" disabled={!dirty || busy} onClick={save}>
              Save draft
            </Button>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={reviewed}
                disabled={dirty || busy}
                onChange={(e) => review(e.target.checked)}
              />
              <span>I have reviewed this draft</span>
            </label>
            <Button disabled={!reviewed || dirty || busy} onClick={() => exportAs('pdf')}>
              Export PDF
            </Button>
            <Button disabled={!reviewed || dirty || busy} onClick={() => exportAs('docx')}>
              Export Word
            </Button>
            {needsRubric && (
              <Button disabled={drafting || busy} onClick={redoInRubric}>
                Draft again in rubric mode
              </Button>
            )}
          </div>
          {dirty && (
            <p className={styles.hint}>You have unsaved changes. Save before you review or export.</p>
          )}
        </div>
      )}
    </Card>
  );
}
