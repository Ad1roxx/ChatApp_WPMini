/**
 * SubmissionRow — one student's side of one assignment
 *
 * Used in three places that each want a different slice:
 *
 *   the mentorship page   one student, many assignments  → show the brief
 *   the mentor's review   one assignment, many students  → show the student
 *   the student's list    their own work, every mentor   → show the brief
 *
 * It owns its own forms and calls the API itself, so each page only says
 * which slice to show and what to do with the updated row that comes back.
 *
 * `viewer` decides the words. A mentor and a student want opposite things
 * from the same state — "submitted" means *waiting on you* to one and
 * *waiting on them* to the other — so the badge, the headings, the quote and
 * the history are all written from the reader's side of the desk.
 */

import { useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Avatar from './Avatar';
import Badge from './Badge';
import Button from './Button';
import { Field, Input, Textarea } from './Field';
import { useToast } from './Toast';
import { CloseIcon, PaperclipIcon } from './Icons';
import useNow, { relative } from '../lib/useNow';
import { ACCEPT, MAX_FILE_BYTES, MAX_FILES, formatBytes } from '../lib/attachments';
import styles from './SubmissionRow.module.css';

/** What each logged event is called, in the history. */
const EVENT_LABEL = {
  assigned: 'Assigned',
  'draft-saved': 'Draft saved',
  'file-attached': 'Attached',
  'file-removed': 'Removed',
  submitted: 'Handed in',
  unsubmitted: 'Unsubmitted',
  'changes-requested': 'Changes asked for',
  accepted: 'Accepted'
};

/** What this hand-in's state says, to whoever is reading it. */
function statusBadge(sub, viewer) {
  const isMentor = viewer === 'mentor';

  if (sub.status === 'accepted') return { variant: 'success', label: 'Accepted' };
  if (sub.status === 'changes-requested') {
    return { variant: 'warning', label: isMentor ? 'Changes asked for' : 'Needs changes' };
  }
  if (sub.status === 'submitted') {
    return { variant: 'accent', label: isMentor ? 'To review' : 'Handed in' };
  }
  // Work attached but not turned in. The mentor asked to see exactly this.
  if (sub.status === 'draft') {
    if (sub.late) {
      return { variant: 'danger', label: isMentor ? 'Overdue · draft attached' : 'Overdue · draft saved' };
    }
    return {
      variant: 'warning',
      label: isMentor ? 'Attached, not handed in' : 'Draft — not handed in'
    };
  }
  // Nothing attached at all. Late is the more useful thing to say.
  if (sub.late) return { variant: 'danger', label: 'Overdue' };
  return { variant: 'neutral', label: isMentor ? 'Not handed in' : 'To do' };
}

const fmtDue = (d) =>
  `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/** An absolute timestamp, for the history — "when" needs to survive a screenshot. */
const fmtStamp = (d) =>
  `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/**
 * The files on a hand-in. Each name downloads it; `onRemove` adds a remove
 * button, which only the student gets and only while the work is editable.
 */
function FileList({ files, onDownload, onRemove, busy }) {
  return (
    <ul className={styles.files}>
      {files.map((f) => (
        <li key={f.fileId} className={styles.file}>
          <PaperclipIcon size={14} className={styles.fileIcon} />
          <button
            type="button"
            className={styles.fileName}
            onClick={() => onDownload(f)}
            title={`Download ${f.name}`}
          >
            {f.name}
          </button>
          <span className={styles.fileSize}>{formatBytes(f.size)}</span>
          {onRemove && (
            <button
              type="button"
              className={styles.fileRemove}
              onClick={() => onRemove(f)}
              disabled={busy}
              aria-label={`Remove ${f.name}`}
            >
              <CloseIcon size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function SubmissionRow({
  submission,
  viewer,
  showAssignment = false,
  showStudent = false,
  dueAt,
  onChanged
}) {
  const { authFetch } = useAuth();
  const toast = useToast();
  const now = useNow();
  const fileInput = useRef(null);

  // null | 'handin' | 'review'
  const [mode, setMode] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const sub = submission;
  const assignment = typeof sub.assignment === 'object' ? sub.assignment : null;
  const deadline = dueAt || assignment?.dueAt || null;
  const badge = statusBadge(sub, viewer);
  const isMentor = viewer === 'mentor';
  const isDraft = sub.status === 'draft';
  const files = sub.attachments || [];
  const hasWork = Boolean(sub.text || sub.url || files.length);
  const history = sub.history || [];

  const studentId = String(sub.student?._id || sub.student);

  /** Who did a logged thing, from the reader's side of the desk. */
  const actor = (event) => {
    const byStudent = String(event.by) === studentId;
    if (isMentor) return byStudent ? sub.student?.displayName || 'the student' : 'you';
    return byStudent ? 'you' : 'your mentor';
  };

  const call = async (path, method, body, success, { keepOpen = false } = {}) => {
    setBusy(true);

    try {
      const res = await authFetch(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      if (res.ok) {
        onChanged?.(await res.json());
        if (!keepOpen) setMode(null);
        toast.success(success);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not save that');
      }
    } catch (err) {
      console.error('Error updating hand-in:', err);
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const base = `/api/submissions/${sub._id}`;

  const save = (turnIn) =>
    call(base, 'PUT', { text, url, turnIn }, turnIn ? 'Handed in' : 'Draft saved');

  // Turn in the draft exactly as it stands, without reopening the editor.
  const turnInDraft = () =>
    call(base, 'PUT', { text: sub.text, url: sub.url, turnIn: true }, 'Handed in');

  const unsubmit = () =>
    call(`${base}/unsubmit`, 'POST', undefined, 'Taken back — it is a draft again');

  const openEditor = () => {
    setText(sub.text || '');
    setUrl(sub.url || '');
    setMode('handin');
  };

  /**
   * Upload straight away, the way Classroom does: picking a file attaches it,
   * and the work becomes a draft the mentor can see. Several files go one at
   * a time, stopping at the first refusal so the message names the file.
   */
  const attach = async (picked) => {
    if (picked.length === 0) return;

    if (files.length + picked.length > MAX_FILES) {
      toast.error(`Up to ${MAX_FILES} files per hand-in`);
      return;
    }

    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      toast.error(`${tooBig.name} is over ${formatBytes(MAX_FILE_BYTES)}`);
      return;
    }

    setUploading(true);

    try {
      for (const file of picked) {
        const form = new FormData();
        form.append('file', file);

        const res = await authFetch(`${base}/files`, { method: 'POST', body: form });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || `Could not attach ${file.name}`);
          return;
        }
        onChanged?.(await res.json());
      }

      toast.success(
        picked.length === 1 ? `Attached ${picked[0].name}` : `Attached ${picked.length} files`
      );
    } catch (err) {
      console.error('Error attaching file:', err);
      toast.error('Could not reach the server');
    } finally {
      setUploading(false);
    }
  };

  const detach = (f) =>
    call(`${base}/files/${f.fileId}`, 'DELETE', undefined, `Removed ${f.name}`, {
      keepOpen: true
    });

  /**
   * Download through authFetch rather than a plain link. The file route needs
   * the sign-in token, which an <a href> cannot send — and putting the token
   * in the URL would leave it in browser history and server logs.
   */
  const download = async (f) => {
    try {
      const res = await authFetch(`${base}/files/${f.fileId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not download that file');
        return;
      }

      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Freed a minute later, long after the browser has taken the bytes.
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    } catch (err) {
      console.error('Error downloading file:', err);
      toast.error('Could not reach the server');
    }
  };

  return (
    <li className={styles.row}>
      <div className={styles.topLine}>
        {showStudent ? (
          <span className={styles.who}>
            <Avatar src={sub.student?.photoURL} name={sub.student?.displayName} size="sm" />
            <span className={styles.name}>{sub.student?.displayName || 'A student'}</span>
          </span>
        ) : (
          <h3 className={styles.title}>{assignment?.title}</h3>
        )}
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {showAssignment && assignment && (
        <>
          <p className={styles.due}>
            Due{' '}
            <time dateTime={new Date(assignment.dueAt).toISOString()}>
              {fmtDue(new Date(assignment.dueAt))}
            </time>
            <span className={styles.dim}>
              {' · '}
              {relative(new Date(assignment.dueAt), now)}
              {/* On the student's own list the work comes from several
                  mentors, and "from whom" is not otherwise on the row. */}
              {!isMentor && assignment.mentor?.displayName
                ? ` · from ${assignment.mentor.displayName}`
                : ''}
            </span>
          </p>

          {assignment.instructions && (
            <p className={styles.instructions}>{assignment.instructions}</p>
          )}
        </>
      )}

      {/* The work — handed in, or attached as a draft. A draft gets a dashed
          edge, so "not final" reads before a single word does. */}
      {hasWork && mode !== 'handin' && (sub.submittedAt || isDraft) && (
        <div
          className={[styles.submission, isDraft ? styles.submissionDraft : '']
            .filter(Boolean)
            .join(' ')}
        >
          <span className={styles.submissionHead}>
            {isDraft
              ? isMentor
                ? 'Attached, not handed in'
                : 'Your draft'
              : isMentor
                ? 'Handed in'
                : 'You handed in'}
            <span className={styles.dim}>
              {' · '}
              {isDraft
                ? `saved ${relative(new Date(sub.draftSavedAt || sub.updatedAt), now)}`
                : relative(new Date(sub.submittedAt), now)}
              {!isDraft && sub.late ? ' · late' : ''}
            </span>
          </span>

          {sub.text && <p className={styles.submissionText}>{sub.text}</p>}

          {/* noopener: a target=_blank page otherwise gets a handle back to
              this one. noreferrer: the link should not learn which
              mentorship it was opened from. */}
          {sub.url && (
            <a
              href={sub.url}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.submissionLink}
            >
              {sub.url}
            </a>
          )}

          {files.length > 0 && <FileList files={files} onDownload={download} />}

          {/* Said plainly, because the student should never be surprised
              that a draft was visible. */}
          {isDraft && !isMentor && (
            <p className={styles.draftNotice}>
              Your mentor can see this, but it is not handed in until you press Hand in.
            </p>
          )}
        </div>
      )}

      {sub.review?.reviewedAt && sub.review.note && mode !== 'review' && (
        <blockquote className={styles.reviewNote}>
          <span className={styles.dim}>{isMentor ? 'You said: ' : 'Your mentor said: '}</span>
          {sub.review.note}
        </blockquote>
      )}

      {mode === 'handin' && (
        <div className={styles.inlineForm}>
          <Field label="Your answer" hint="Text, a link, files — any mix of them">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What you did, or the answer itself"
              maxLength={5000}
              rows={4}
              autoFocus
            />
          </Field>

          <Field label="Link" hint="Optional — a repo, a doc, a live page">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              maxLength={2000}
            />
          </Field>

          <div className={styles.attach}>
            <span className={styles.attachLabel}>Files</span>

            {files.length > 0 && (
              <FileList
                files={files}
                onDownload={download}
                onRemove={detach}
                busy={busy || uploading}
              />
            )}

            <div className={styles.attachRow}>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  // Copied before the input is reset, so the same file can
                  // be picked again after removing it.
                  const picked = [...e.target.files];
                  e.target.value = '';
                  attach(picked);
                }}
              />
              <Button
                size="sm"
                loading={uploading}
                disabled={busy || files.length >= MAX_FILES}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? 'Uploading' : 'Attach files'}
              </Button>
              <span className={styles.attachHint}>
                Up to {MAX_FILES}, {formatBytes(MAX_FILE_BYTES)} each. Attaching saves a
                draft your mentor can see.
              </span>
            </div>
          </div>

          <div className={styles.inlineActions}>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Never mind
            </Button>
            <Button
              size="sm"
              disabled={busy || uploading || (!text.trim() && !url.trim())}
              onClick={() => save(false)}
            >
              Save draft
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || uploading || (!text.trim() && !url.trim() && files.length === 0)}
              onClick={() => save(true)}
            >
              Hand in
            </Button>
          </div>
        </div>
      )}

      {mode === 'review' && (
        <div className={styles.inlineForm}>
          <Field label="What needs changing?" hint="Required — they cannot guess">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Be specific about what to redo"
              maxLength={2000}
              rows={3}
              autoFocus
            />
          </Field>

          <div className={styles.inlineActions}>
            <Button size="sm" onClick={() => setMode(null)}>
              Never mind
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !note.trim()}
              onClick={() =>
                call(base, 'PATCH', { action: 'request-changes', note }, 'Sent back for changes')
              }
            >
              Send it back
            </Button>
          </div>
        </div>
      )}

      {mode === null && (
        <div className={styles.actions}>
          {/* ---- Student ---- */}
          {!isMentor && sub.status === 'assigned' && (
            <Button size="sm" variant="primary" disabled={busy} onClick={openEditor}>
              Hand in
            </Button>
          )}

          {!isMentor && isDraft && (
            <>
              <Button size="sm" variant="primary" disabled={busy || !hasWork} onClick={turnInDraft}>
                Hand in
              </Button>
              <Button size="sm" disabled={busy} onClick={openEditor}>
                Edit draft
              </Button>
            </>
          )}

          {!isMentor && sub.status === 'changes-requested' && (
            <Button size="sm" variant="primary" disabled={busy} onClick={openEditor}>
              Hand in again
            </Button>
          )}

          {/* Handed in and not yet reviewed: the only way back is Unsubmit,
              which is logged. Offering "Hand in again" here would be an edit
              the history never saw. */}
          {!isMentor && sub.status === 'submitted' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={unsubmit}>
              Unsubmit
            </Button>
          )}

          {/* ---- Mentor ---- */}
          {isMentor && sub.status === 'submitted' && (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => call(base, 'PATCH', { action: 'accept' }, 'Accepted')}
              >
                Accept
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setNote('');
                  setMode('review');
                }}
              >
                Ask for changes
              </Button>
            </>
          )}

          {history.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory((v) => !v)}
              aria-expanded={showHistory}
            >
              {showHistory ? 'Hide history' : `History (${history.length})`}
            </Button>
          )}
        </div>
      )}

      {/* The log, oldest first, so it reads as the story of what happened:
          assigned, draft saved, handed in, unsubmitted, handed in again.
          Absolute timestamps rather than "3 days ago", because a history is
          the thing you screenshot and send to someone else. */}
      {showHistory && history.length > 0 && (
        <ol className={styles.history} aria-label="History">
          {history.map((event, i) => {
            const at = new Date(event.at);
            const lateHandIn =
              event.type === 'submitted' &&
              deadline &&
              at.getTime() > new Date(deadline).getTime();

            return (
              <li key={i} className={styles.event}>
                <span className={styles.eventDot} data-type={event.type} aria-hidden="true" />
                <span className={styles.eventLabel}>
                  {EVENT_LABEL[event.type] || event.type}
                  {event.detail && <span className={styles.eventDetail}> {event.detail}</span>}
                  {lateHandIn && <span className={styles.eventLate}> · late</span>}
                  <span className={styles.dim}> · {actor(event)}</span>
                </span>
                <time className={styles.eventTime} dateTime={at.toISOString()}>
                  {fmtStamp(at)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}
