/**
 * CriteriaPanel — the mentor's confirmation screen for a rubric's criteria
 *
 * Shown only to the mentor who set the assignment, and only when one of the
 * brief's files is marked as the rubric. The server enforces both (403 for
 * anyone else); this only decides what to draw.
 *
 * The AI proposes criteria from the rubric file; nothing is assessed until the
 * mentor confirms a checklist. Every server string is rendered as plain text.
 * The client sends only text, from, marks and weight per criterion.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Button from './Button';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import {
  addRow,
  mergeRows,
  problemWith,
  removeRow,
  rowsFrom,
  toConfirmBody,
  updateRow
} from '../lib/criteria';
import styles from './CriteriaPanel.module.css';

const formatDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

const sectionsText = (sections) => {
  const list = (sections || []).map(String);
  if (list.length === 0) return 'Some sections could not be read';
  if (list.length === 1) return `Section ${list[0]} could not be read`;
  return `Sections ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} could not be read`;
};

const numOrNull = (value, max) => {
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), max);
};

export default function CriteriaPanel({ assignmentId }) {
  const { authFetch, socket } = useAuth();
  const toast = useToast();

  const [files, setFiles] = useState(null);
  const [sets, setSets] = useState(null);
  const [setId, setSetId] = useState(null);
  const [rows, setRows] = useState([]);
  const [picked, setPicked] = useState([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [openVersion, setOpenVersion] = useState(null);

  const filesUrl = `/api/assignments/${assignmentId}/files`;
  const base = `/api/assignments/${assignmentId}/criteria`;

  const rubric = (files || []).find((f) => f.rubric?.isRubric) || null;
  const set = (sets || []).find((s) => s.id === setId) || null;
  const select = useCallback((list, id) => {
    const chosen = list.find((s) => s.id === id) || null;
    setSetId(chosen ? chosen.id : null);
    setRows(chosen ? rowsFrom(chosen, { fromExtraction: false }) : []);
    setPicked([]);
  }, []);

  // The checklist shown by default is the current rubric file's, never one left
  // from a file that has since been unmarked; none yet means "extract".
  const rubricKey = rubric ? String(rubric.fileId) : '';
  useEffect(() => {
    if (!sets || sets.some((s) => s.id === setId)) return;
    const match = sets.find((s) => rubricKey && String(s.source?.fileId) === rubricKey);
    if (match) select(sets, match.id);
  }, [rubricKey, sets]); // eslint-disable-line react-hooks/exhaustive-deps

  // The brief's files, to know whether a rubric is marked. Refetched when the
  // brief changes, like AssignmentFiles does.
  useEffect(() => {
    let stale = false;
    const load = async () => {
      try {
        const res = await authFetch(filesUrl);
        if (res.ok && !stale) setFiles((await res.json()).attachments || []);
      } catch (err) {
        console.error('Error loading assignment files:', err);
      }
    };
    load();
    if (!socket) return () => { stale = true; };
    const handle = (payload) => {
      if (payload?.assignmentId && String(payload.assignmentId) !== String(assignmentId)) return;
      load();
    };
    socket.on('assignment-changed', handle);
    return () => {
      stale = true;
      socket.off('assignment-changed', handle);
    };
  }, [authFetch, socket, filesUrl, assignmentId]);

  const loadSets = useCallback(
    async (preferId) => {
      try {
        const res = await authFetch(base);
        if (!res.ok) return;
        const list = (await res.json()).sets || [];
        setSets(list);
        select(list, preferId);
      } catch (err) {
        console.error('Error loading criteria:', err);
      }
    },
    [authFetch, base, select]
  );

  const hasRubric = Boolean(rubric);
  useEffect(() => {
    if (hasRubric) loadSets();
  }, [hasRubric, loadSets]);

  if (!rubric) return null;

  const extract = async () => {
    setReading(true);
    setNotice('');
    try {
      const res = await authFetch(`${base}/extract`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || 'Could not read the rubric');
        return;
      }
      const next = [...(sets || []).filter((s) => s.id !== body.id), body];
      setSets(next);
      setSetId(body.id);
      setRows(rowsFrom(body, { fromExtraction: !body.latest }));
      setPicked([]);
    } catch (err) {
      console.error('Error reading the rubric:', err);
      toast.error('Could not reach the server');
    } finally {
      setReading(false);
    }
  };

  const confirm = async () => {
    const problem = problemWith(rows);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${base}/${set.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toConfirmBody(rows))
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const next = (sets || []).map((s) => (s.id === body.id ? body : s));
        setSets(next);
        setRows(rowsFrom(body, { fromExtraction: false }));
        setPicked([]);
        setNotice(`Version ${body.latest?.n} confirmed`);
        toast.success(`Version ${body.latest?.n} confirmed`);
      } else {
        toast.error(body.error || 'Could not confirm the checklist');
        if (res.status === 409) await loadSets(set.id);
      }
    } catch (err) {
      console.error('Error confirming criteria:', err);
      toast.error('Could not reach the server');
    } finally {
      setSaving(false);
    }
  };

  const latest = set?.latest || null;
  const extracted = set?.extracted || null;
  const newerExtraction =
    latest && extracted?.at && new Date(extracted.at) > new Date(latest.confirmedAt);
  const busy = reading || saving;
  const patch = (key, p) => setRows((r) => updateRow(r, key, p));

  return (
    <section className={styles.panel} aria-label="Rubric criteria">
      <div className={styles.header}>
        <span className={styles.title}>Rubric criteria</span>
        <span className={styles.file}>{rubric.name}</span>
      </div>
      <p className={styles.version}>
        {latest
          ? `Version ${latest.n}, confirmed ${formatDate(latest.confirmedAt)}`
          : 'Not confirmed yet: nothing will be assessed until you confirm'}
      </p>

      <div className={styles.row}>
        <Button size="sm" loading={reading} disabled={busy} onClick={extract}>
          Read criteria from the rubric
        </Button>
        {reading && <InlineLoader label="Reading the rubric…" />}
      </div>

      {sets === null && !reading && <InlineLoader label="Loading criteria" />}

      {extracted?.notRead?.length > 0 && (
        <div className={styles.warning} role="status">
          {extracted.notRead.map((n, i) => (
            <p key={i}>
              {sectionsText(n.sections)}
              {n.reason ? `: ${n.reason}` : ''}
            </p>
          ))}
        </div>
      )}

      {extracted?.rejected?.length > 0 && (
        <details className={styles.details}>
          <summary>Not used ({extracted.rejected.length})</summary>
          <ul className={styles.plain}>
            {extracted.rejected.map((r, i) => (
              <li key={i}>
                <q className={styles.inlineQuote}>{r.sourceText}</q>
                <span className={styles.hint}> {r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {set && (
        <>
          {newerExtraction && (
            <div className={styles.row}>
              <span className={styles.hint}>There is a newer reading of the rubric.</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setRows(rowsFrom(set, { fromExtraction: true }));
                  setPicked([]);
                }}
              >
                Start again from the new extraction
              </Button>
            </div>
          )}

          {rows.length === 0 && (
            <p className={styles.hint}>No criteria yet. Read them from the rubric or add one.</p>
          )}

          <ul className={styles.rows}>
            {rows.map((r) => (
              <li key={r.key} className={styles.item}>
                <input
                  type="checkbox"
                  aria-label="Select for merging"
                  checked={picked.includes(r.key)}
                  onChange={(e) =>
                    setPicked((p) => (e.target.checked ? [...p, r.key] : p.filter((k) => k !== r.key)))
                  }
                />
                <div className={styles.body}>
                  {r.sourceText ? (
                    <blockquote className={styles.quote}>{r.sourceText}</blockquote>
                  ) : (
                    <span className={styles.hint}>Added by you</span>
                  )}
                  <input
                    className={styles.text}
                    type="text"
                    aria-label="Criterion wording"
                    value={r.text}
                    maxLength={1000}
                    onChange={(e) => patch(r.key, { text: e.target.value })}
                  />
                </div>
                <label className={styles.marks}>
                  <span className={styles.hint}>Marks</span>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    value={r.marks ?? ''}
                    onChange={(e) => patch(r.key, { marks: numOrNull(e.target.value, 1000) })}
                  />
                </label>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => {
                    setRows((x) => removeRow(x, r.key));
                    setPicked((p) => p.filter((k) => k !== r.key));
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className={styles.row}>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || picked.length < 2}
              onClick={() => {
                setRows((x) => mergeRows(x, picked));
                setPicked([]);
              }}
            >
              Merge selected
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRows((x) => addRow(x))}>
              Add criterion
            </Button>
            <Button size="sm" loading={saving} disabled={busy} onClick={confirm}>
              Confirm checklist
            </Button>
            {notice && <span className={styles.hint}>{notice}</span>}
          </div>

          {set.versions?.length > 0 && (
            <div className={styles.history}>
              <span className={styles.title}>Versions</span>
              <ul className={styles.plain}>
                {[...set.versions].reverse().map((v) => (
                  <li key={v.n}>
                    <button
                      type="button"
                      className={styles.remove}
                      aria-expanded={openVersion === v.n}
                      onClick={() => setOpenVersion(openVersion === v.n ? null : v.n)}
                    >
                      Version {v.n}, {formatDate(v.confirmedAt)}, {v.criteria.length}{' '}
                      {v.criteria.length === 1 ? 'criterion' : 'criteria'}
                    </button>
                    {openVersion === v.n && (
                      <ol className={styles.plain}>
                        {v.criteria.map((k) => (
                          <li key={k.id}>
                            {k.text}
                            {k.marks != null && <span className={styles.hint}> ({k.marks} marks)</span>}
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
