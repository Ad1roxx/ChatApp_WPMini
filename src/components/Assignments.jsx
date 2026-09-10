/**
 * Assignments — work set by the mentor, handed in by the student
 *
 * The piece goals deliberately does not do. A goal is a checklist of progress
 * over weeks and either party ticks it; an assignment has a deadline, the
 * student produces something, and the mentor answers it.
 *
 * The two halves never overlap, and the UI says so: a mentor sees Accept and
 * Ask for changes and never a submit box; a student sees the submit box and
 * never a review control. The server enforces both, so this only decides what
 * to render.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import Card from './Card';
import Button from './Button';
import Badge from './Badge';
import { Field, Input, Textarea } from './Field';
import ConfirmDialog from './ConfirmDialog';
import EmptyState from './EmptyState';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import { ClipboardIcon } from './Icons';
import useNow, { relative } from '../lib/useNow';
import styles from './Assignments.module.css';

/**
 * `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time, so the offset has
 * to come off before `toISOString` — the same conversion the session form
 * uses, and wrong in the same way without it.
 */
function toLocalInput(date) {
  const ms = date.getTime() - date.getTimezoneOffset() * 60000;
  return new Date(ms).toISOString().slice(0, 16);
}

/** A week out, end of the working day — a plausible default for homework. */
function defaultDue() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(17, 0, 0, 0);
  return toLocalInput(d);
}

/**
 * What each state says, from the point of view of whoever is reading it.
 *
 * A mentor and a student want opposite things from the same word: "submitted"
 * means *waiting on you* to a mentor and *waiting on them* to a student, and
 * a single neutral label would be useless to both.
 */
function statusBadge(a, isMentor) {
  if (a.status === 'accepted') return { variant: 'success', label: 'Accepted' };
  if (a.status === 'changes-requested') {
    return { variant: 'warning', label: isMentor ? 'Changes asked for' : 'Needs changes' };
  }
  if (a.status === 'submitted') {
    return { variant: 'accent', label: isMentor ? 'To review' : 'Handed in' };
  }
  // Not handed in. Late is the more useful thing to say than "assigned".
  if (a.late) return { variant: 'danger', label: 'Overdue' };
  return { variant: 'neutral', label: 'To do' };
}

export default function Assignments({ mentorshipId, active, isMentor }) {
  const { socket, authFetch } = useAuth();
  const toast = useToast();
  const now = useNow();

  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  // Set-an-assignment form (mentor)
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [saving, setSaving] = useState(false);

  // Inline editors, each holding the id of the one assignment it applies to
  const [submitId, setSubmitId] = useState(null);
  const [subText, setSubText] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const [reviewId, setReviewId] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const [withdrawing, setWithdrawing] = useState(null);

  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch(`/api/mentorships/${mentorshipId}/assignments`);
        if (res.ok && !stale) setAssignments(await res.json());
      } catch (err) {
        console.error('Error loading assignments:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    return () => {
      stale = true;
    };
  }, [mentorshipId, authFetch]);

  useEffect(() => {
    if (!socket) return undefined;

    const handleUpdate = (a) => {
      if (String(a.mentorship) !== mentorshipId) return;
      setAssignments((prev) => {
        const exists = prev.some((x) => x._id === a._id);
        return exists ? prev.map((x) => (x._id === a._id ? a : x)) : [...prev, a];
      });
    };

    const handleRemove = ({ _id, mentorship }) => {
      if (String(mentorship) !== mentorshipId) return;
      setAssignments((prev) => prev.filter((x) => x._id !== _id));
    };

    socket.on('assignment-updated', handleUpdate);
    socket.on('assignment-removed', handleRemove);

    return () => {
      socket.off('assignment-updated', handleUpdate);
      socket.off('assignment-removed', handleRemove);
    };
  }, [socket, mentorshipId]);

  const replace = (updated) =>
    setAssignments((prev) => prev.map((x) => (x._id === updated._id ? updated : x)));

  const set = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await authFetch(`/api/mentorships/${mentorshipId}/assignments`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          instructions,
          dueAt: new Date(due).toISOString()
        })
      });

      if (res.ok) {
        const a = await res.json();
        setAssignments((prev) => [...prev, a]);
        setTitle('');
        setInstructions('');
        setDue(defaultDue());
        setFormOpen(false);
        toast.success('Assignment set');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not set that assignment');
      }
    } catch (err) {
      console.error('Error setting assignment:', err);
      toast.error('Could not reach the server');
    } finally {
      setSaving(false);
    }
  };

  const submit = useCallback(
    async (a) => {
      setBusyId(a._id);

      try {
        const res = await authFetch(`/api/assignments/${a._id}/submission`, {
          method: 'PUT',
          body: JSON.stringify({ text: subText, url: subUrl })
        });

        if (res.ok) {
          replace(await res.json());
          setSubmitId(null);
          toast.success('Handed in');
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || 'Could not hand that in');
        }
      } catch (err) {
        console.error('Error submitting:', err);
        toast.error('Could not reach the server');
      } finally {
        setBusyId(null);
      }
    },
    [authFetch, subText, subUrl, toast]
  );

  const review = useCallback(
    async (a, action, note) => {
      setBusyId(a._id);

      try {
        const res = await authFetch(`/api/assignments/${a._id}`, {
          method: 'PATCH',
          body: JSON.stringify({ action, note })
        });

        if (res.ok) {
          replace(await res.json());
          setReviewId(null);
          toast.success(action === 'accept' ? 'Accepted' : 'Sent back for changes');
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || 'Could not review that');
        }
      } catch (err) {
        console.error('Error reviewing:', err);
        toast.error('Could not reach the server');
      } finally {
        setBusyId(null);
      }
    },
    [authFetch, toast]
  );

  const withdraw = async (a) => {
    setBusyId(a._id);

    try {
      const res = await authFetch(`/api/assignments/${a._id}`, { method: 'DELETE' });

      if (res.ok) {
        setAssignments((prev) => prev.filter((x) => x._id !== a._id));
        toast.success('Assignment withdrawn');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not withdraw that');
      }
    } catch (err) {
      console.error('Error withdrawing:', err);
      toast.error('Could not reach the server');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <Card title="Assignments">
        <InlineLoader label="Loading assignments" />
      </Card>
    );
  }

  // Outstanding first, in deadline order; finished ones settle underneath.
  const open = assignments.filter((a) => a.status !== 'accepted');
  const done = assignments.filter((a) => a.status === 'accepted');
  const owed = isMentor
    ? open.filter((a) => a.status === 'submitted').length
    : open.filter((a) => a.status !== 'submitted').length;

  const renderOne = (a) => {
    const badge = statusBadge(a, isMentor);
    const busy = busyId === a._id;
    const dueDate = new Date(a.dueAt);
    const submitting = submitId === a._id;
    const reviewing = reviewId === a._id;

    return (
      <li key={a._id} className={styles.row}>
        <div className={styles.topLine}>
          <h3 className={styles.title}>{a.title}</h3>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>

        <p className={styles.due}>
          Due{' '}
          <time dateTime={dueDate.toISOString()}>
            {dueDate.toLocaleDateString([], {
              weekday: 'short',
              day: 'numeric',
              month: 'short'
            })}
            {', '}
            {dueDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </time>
          <span className={styles.dim}> · {relative(dueDate, now)}</span>
        </p>

        {a.instructions && <p className={styles.instructions}>{a.instructions}</p>}

        {/* What was handed in. Shown to both, because the mentor needs to
            review it and the student needs to see what they sent. */}
        {a.submission?.submittedAt && !submitting && (
          <div className={styles.submission}>
            <span className={styles.submissionHead}>
              {isMentor ? 'Handed in' : 'You handed in'}
              <span className={styles.dim}>
                {' · '}
                {relative(new Date(a.submission.submittedAt), now)}
                {a.late ? ' · late' : ''}
              </span>
            </span>

            {a.submission.text && <p className={styles.submissionText}>{a.submission.text}</p>}

            {a.submission.url && (
              <a
                href={a.submission.url}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.submissionLink}
              >
                {a.submission.url}
              </a>
            )}
          </div>
        )}

        {/* The mentor's answer, once given. */}
        {a.review?.reviewedAt && a.review.note && !reviewing && (
          <blockquote className={styles.reviewNote}>
            <span className={styles.dim}>{isMentor ? 'You said: ' : 'Your mentor said: '}</span>
            {a.review.note}
          </blockquote>
        )}

        {/* ---- Student: hand it in ---- */}
        {submitting && (
          <div className={styles.inlineForm}>
            <Field label="Your answer" hint="Text, a link, or both">
              <Textarea
                value={subText}
                onChange={(e) => setSubText(e.target.value)}
                placeholder="What you did, or the answer itself"
                maxLength={5000}
                rows={4}
                autoFocus
              />
            </Field>

            <Field label="Link" hint="Optional — http or https">
              <Input
                type="url"
                value={subUrl}
                onChange={(e) => setSubUrl(e.target.value)}
                placeholder="https://…"
                maxLength={2000}
              />
            </Field>

            <div className={styles.inlineActions}>
              <Button size="sm" onClick={() => setSubmitId(null)}>
                Never mind
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || (!subText.trim() && !subUrl.trim())}
                onClick={() => submit(a)}
              >
                Hand in
              </Button>
            </div>
          </div>
        )}

        {/* ---- Mentor: ask for changes ---- */}
        {reviewing && (
          <div className={styles.inlineForm}>
            <Field label="What needs changing?" hint="Required — they cannot guess">
              <Textarea
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="Be specific about what to redo"
                maxLength={2000}
                rows={3}
                autoFocus
              />
            </Field>

            <div className={styles.inlineActions}>
              <Button size="sm" onClick={() => setReviewId(null)}>
                Never mind
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !reviewNote.trim()}
                onClick={() => review(a, 'request-changes', reviewNote)}
              >
                Send it back
              </Button>
            </div>
          </div>
        )}

        {!submitting && !reviewing && (
          <div className={styles.actions}>
            {!isMentor && a.status !== 'accepted' && (
              <Button
                size="sm"
                variant={a.status === 'submitted' ? 'secondary' : 'primary'}
                disabled={busy}
                onClick={() => {
                  setSubText(a.submission?.text || '');
                  setSubUrl(a.submission?.url || '');
                  setSubmitId(a._id);
                }}
              >
                {a.submission?.submittedAt ? 'Hand in again' : 'Hand in'}
              </Button>
            )}

            {isMentor && a.status === 'submitted' && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => review(a, 'accept', '')}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setReviewNote('');
                    setReviewId(a._id);
                  }}
                >
                  Ask for changes
                </Button>
              </>
            )}

            {isMentor && a.status !== 'accepted' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setWithdrawing(a)}
              >
                Withdraw
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <Card
        title="Assignments"
        subtitle={
          owed > 0
            ? isMentor
              ? `${owed} waiting on you to review`
              : `${owed} still to hand in`
            : undefined
        }
        actions={
          active &&
          isMentor && (
            <Button
              size="sm"
              variant={formOpen ? 'secondary' : 'primary'}
              onClick={() => setFormOpen((o) => !o)}
            >
              {formOpen ? 'Cancel' : 'Set an assignment'}
            </Button>
          )
        }
      >
        {formOpen && (
          <form onSubmit={set} className={styles.form}>
            <Field label="What should they do?">
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Solve five array problems"
                maxLength={200}
                autoFocus
              />
            </Field>

            <Field label="Due by">
              <Input
                type="datetime-local"
                value={due}
                min={toLocalInput(new Date(now))}
                onChange={(e) => setDue(e.target.value)}
              />
            </Field>

            <Field label="Instructions" hint="Optional">
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="What good looks like, and how to hand it in"
                maxLength={5000}
                rows={4}
              />
            </Field>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!title.trim() || !due}
              >
                {saving ? 'Setting' : 'Set assignment'}
              </Button>
            </div>
          </form>
        )}

        {assignments.length === 0 && !formOpen && (
          <EmptyState
            icon={<ClipboardIcon size={20} />}
            title="Nothing set"
            description={
              isMentor
                ? 'Set something specific with a deadline. Goals are the long game — this is the work in between.'
                : 'Your mentor has not set any work yet.'
            }
            action={
              active && isMentor ? (
                <Button variant="primary" onClick={() => setFormOpen(true)}>
                  Set an assignment
                </Button>
              ) : undefined
            }
          />
        )}

        {open.length > 0 && <ul className={styles.list}>{open.map(renderOne)}</ul>}
      </Card>

      {done.length > 0 && (
        <Card title="Accepted work" subtitle="Finished and signed off">
          <ul className={styles.list}>{done.map(renderOne)}</ul>
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(withdrawing)}
        title="Withdraw this assignment?"
        description="It disappears for both of you, along with anything already handed in. Accepted work cannot be withdrawn."
        confirmLabel="Withdraw"
        destructive
        onConfirm={async () => {
          const target = withdrawing;
          setWithdrawing(null);
          await withdraw(target);
        }}
        onCancel={() => setWithdrawing(null)}
      />
    </>
  );
}
