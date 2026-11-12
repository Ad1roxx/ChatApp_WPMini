/**
 * Assignments — the work inside one mentorship
 *
 * This is the one-student slice: every assignment this student has been sent,
 * seen from either side of the relationship. The whole-class view — one
 * assignment, every student, "4 of 6 handed in" — lives on the Assignments
 * page, because it spans many mentorships and does not belong inside one.
 *
 * A mentor can set work from here, and it goes to this student alone. There
 * is deliberately no Withdraw on this page: an assignment may have been sent
 * to six students, and pulling it from inside one of their mentorships would
 * take it away from the other five without the mentor seeing them. That
 * action lives where all the recipients are visible.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Card from './Card';
import Button from './Button';
import { Field, Input, Textarea } from './Field';
import EmptyState from './EmptyState';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import { ClipboardIcon } from './Icons';
import SubmissionRow from './SubmissionRow';
import PendingFiles from './PendingFiles';
import { uploadBriefFiles } from '../lib/attachments';
import useNow from '../lib/useNow';
import styles from './Assignments.module.css';

/** `datetime-local` wants local wall-clock time, so the offset comes off first. */
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

export default function Assignments({ mentorshipId, active, isMentor }) {
  const navigate = useNavigate();
  const { socket, authFetch } = useAuth();
  const toast = useToast();
  const now = useNow();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  // Bumped to force a reload from an event handler, which keeps every
  // setState out of an effect body — the one place React's rules object to.
  const [version, setVersion] = useState(0);

  /**
   * Load, and reload whenever anything about an assignment here changes.
   *
   * The loader lives inside the effect rather than being a memoised callback,
   * so the setStates it makes are visibly after an `await`. The socket event
   * carries only an id, because a mentor and a student want differently-shaped
   * answers from the same change — refetching gets each of them the right one.
   */
  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch(`/api/mentorships/${mentorshipId}/assignments`);
        if (res.ok && !stale) setRows(await res.json());
      } catch (err) {
        console.error('Error loading assignments:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    if (!socket) {
      return () => {
        stale = true;
      };
    }

    socket.on('assignment-changed', load);
    return () => {
      stale = true;
      socket.off('assignment-changed', load);
    };
  }, [mentorshipId, authFetch, socket, version]);

  const set = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await authFetch('/api/assignments', {
        method: 'POST',
        body: JSON.stringify({
          title,
          instructions,
          dueAt: new Date(due).toISOString(),
          mentorshipIds: [mentorshipId]
        })
      });

      if (res.ok) {
        const created = await res.json();
        const toSend = pendingFiles;

        setTitle('');
        setInstructions('');
        setDue(defaultDue());
        setPendingFiles([]);
        setFormOpen(false);
        toast.success('Assignment set');

        // The assignment exists whatever happens to its files. A refused file
        // is reported by name and can be added again from the Assignments page;
        // nothing here undoes the assignment.
        if (toSend.length > 0) {
          const { errors } = await uploadBriefFiles(authFetch, created._id, toSend);
          errors.forEach((message) => toast.error(message));
        }
        setVersion((v) => v + 1);
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

  const replace = (updated) =>
    setRows((prev) => prev.map((r) => (r._id === updated._id ? updated : r)));

  if (loading) {
    return (
      <Card title="Assignments">
        <InlineLoader label="Loading assignments" />
      </Card>
    );
  }

  const open = rows.filter((r) => r.status !== 'accepted');
  const done = rows.filter((r) => r.status === 'accepted');
  const owed = isMentor
    ? open.filter((r) => r.status === 'submitted').length
    : open.filter((r) => r.status !== 'submitted').length;

  const viewer = isMentor ? 'mentor' : 'student';

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
            <p className={styles.scope}>
              This goes to this student only.{' '}
              <button
                type="button"
                className={styles.inlineLink}
                onClick={() => navigate('/assignments')}
              >
                Send to several students
              </button>
            </p>

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

            <PendingFiles files={pendingFiles} onChange={setPendingFiles} disabled={saving} />

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

        {rows.length === 0 && !formOpen && (
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

        {open.length > 0 && (
          <ul className={styles.list}>
            {open.map((r) => (
              <SubmissionRow
                key={r._id}
                submission={r}
                viewer={viewer}
                showAssignment
                onChanged={replace}
              />
            ))}
          </ul>
        )}
      </Card>

      {done.length > 0 && (
        <Card title="Accepted work" subtitle="Finished and signed off">
          <ul className={styles.list}>
            {done.map((r) => (
              <SubmissionRow
                key={r._id}
                submission={r}
                viewer={viewer}
                showAssignment
                onChanged={replace}
              />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
