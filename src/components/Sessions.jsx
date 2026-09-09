/**
 * Sessions — the scheduling section of a mentorship
 *
 * A self-contained section rather than more code in MentorshipDetailPage:
 * that page is already 400 lines of goals, and sessions have their own fetch,
 * their own socket subscription and their own set of actions. Splitting on
 * the data boundary keeps both readable.
 *
 * The handshake is the point of the feature and drives the UI: **anyone can
 * propose a time, the other person confirms it.** So the buttons depend on
 * who asked — the proposer waits, the other side gets Confirm. Rescheduling
 * sends it back around the loop, because a confirmed time that quietly
 * changed would leave both people sure they had agreed on different things.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import useNow, { relative } from '../lib/useNow';
import Card from './Card';
import Button from './Button';
import Badge from './Badge';
import { Field, Input, Textarea, Select } from './Field';
import ConfirmDialog from './ConfirmDialog';
import EmptyState from './EmptyState';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import { CalendarIcon } from './Icons';
import styles from './Sessions.module.css';

/** Minutes offered in the picker — the slots people actually book. */
const DURATIONS = [15, 30, 45, 60, 90];

/**
 * A Date as the `YYYY-MM-DDTHH:mm` that `datetime-local` expects.
 *
 * `toISOString` is UTC, so subtracting the offset first is what makes the
 * value round-trip: the control reads and writes local wall-clock time, while
 * the wire format stays ISO.
 */
function toLocalInput(date) {
  const ms = date.getTime() - date.getTimezoneOffset() * 60000;
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * Tomorrow, on the hour. An empty required datetime is a fiddly thing to fill
 * in on a phone, and this is a plausible answer more often than not.
 */
function defaultWhen() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d);
}

const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The label says what is true of the session, not what the status field is
 * called. "Awaiting confirmation" tells you something is owed; "proposed"
 * only names a state.
 */
const STATUS_BADGE = {
  proposed: { variant: 'warning', label: 'Awaiting confirmation' },
  confirmed: { variant: 'success', label: 'Confirmed' },
  completed: { variant: 'neutral', label: 'Done' },
  cancelled: { variant: 'danger', label: 'Cancelled' }
};

export default function Sessions({ mentorshipId, active }) {
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  // Propose form
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [when, setWhen] = useState(defaultWhen);
  const [duration, setDuration] = useState(30);
  const [saving, setSaving] = useState(false);

  // Inline editors, each holding the id of the one session it applies to
  const [movingId, setMovingId] = useState(null);
  const [moveWhen, setMoveWhen] = useState('');
  const [notesId, setNotesId] = useState(null);
  const [notesText, setNotesText] = useState('');

  // Cancelling goes through a dialog: the other person has this time set
  // aside, so it is not a click to make by accident.
  const [cancelling, setCancelling] = useState(null);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch(`/api/mentorships/${mentorshipId}/sessions`);
        if (res.ok && !stale) setSessions(await res.json());
      } catch (err) {
        console.error('Error loading sessions:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    return () => {
      stale = true;
    };
  }, [mentorshipId, authFetch]);

  /** Live updates — the other person confirming shows up without a refresh. */
  useEffect(() => {
    if (!socket) return;

    const handle = (session) => {
      if (session.mentorship !== mentorshipId) return;

      setSessions((prev) => {
        const exists = prev.some((s) => s._id === session._id);
        return exists
          ? prev.map((s) => (s._id === session._id ? session : s))
          : [session, ...prev];
      });
    };

    socket.on('session-updated', handle);
    return () => socket.off('session-updated', handle);
  }, [socket, mentorshipId]);

  /** Every action is the same PATCH, so they share one caller. */
  const patch = useCallback(
    async (session, body, successMessage) => {
      setBusyId(session._id);

      try {
        const res = await authFetch(`/api/sessions/${session._id}`, {
          method: 'PATCH',
          body: JSON.stringify(body)
        });

        if (res.ok) {
          const updated = await res.json();
          setSessions((prev) => prev.map((s) => (s._id === updated._id ? updated : s)));
          if (successMessage) toast.success(successMessage);
          return true;
        }

        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not update that session');
        return false;
      } catch (err) {
        console.error('Error updating session:', err);
        toast.error('Could not reach the server');
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [authFetch, toast]
  );

  const propose = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      // `datetime-local` carries no timezone, so the browser reads it as local
      // wall-clock time — which is what the person typing it meant.
      const res = await authFetch(`/api/mentorships/${mentorshipId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          agenda,
          scheduledFor: new Date(when).toISOString(),
          durationMinutes: Number(duration)
        })
      });

      if (res.ok) {
        const session = await res.json();
        setSessions((prev) => [session, ...prev]);
        setTitle('');
        setAgenda('');
        setWhen(defaultWhen());
        setDuration(30);
        setFormOpen(false);
        toast.success('Time proposed — they need to confirm it');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not propose that time');
      }
    } catch (err) {
      console.error('Error proposing session:', err);
      toast.error('Could not reach the server');
    } finally {
      setSaving(false);
    }
  };

  const me = dbUser?._id;
  const now = useNow();
  const isOpen = (s) => s.status === 'proposed' || s.status === 'confirmed';

  // One pass, two buckets. The server sorts newest first, which is right for
  // history and backwards for a schedule, so upcoming gets reversed.
  const upcoming = sessions
    .filter((s) => isOpen(s) && new Date(s.scheduledFor).getTime() >= now)
    .reverse();
  const past = sessions.filter(
    (s) => !isOpen(s) || new Date(s.scheduledFor).getTime() < now
  );

  const renderSession = (session) => {
    const start = new Date(session.scheduledFor);
    const end = new Date(start.getTime() + session.durationMinutes * 60000);
    const badge = STATUS_BADGE[session.status];
    const busy = busyId === session._id;
    const iProposed = (session.proposedBy?._id || session.proposedBy) === me;
    const started = start.getTime() <= now;
    const moving = movingId === session._id;
    const writingNotes = notesId === session._id;

    return (
      <li key={session._id} className={styles.session}>
        {/* A date rail rather than another line of prose: the date is what you
            scan a list of meetings for, so it gets its own column. Hidden from
            screen readers because the <time> below already says all of it. */}
        <div className={styles.dateRail} aria-hidden="true">
          <span className={styles.weekday}>
            {start.toLocaleDateString([], { weekday: 'short' })}
          </span>
          <span className={styles.day}>{start.getDate()}</span>
          <span className={styles.month}>
            {start.toLocaleDateString([], { month: 'short' })}
          </span>
        </div>

        <div className={styles.body}>
          <div className={styles.topLine}>
            <h3 className={styles.title}>{session.title}</h3>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>

          <p className={styles.time}>
            <time dateTime={start.toISOString()}>
              {/* The rail beside this already shows the date, so printing it
                  again here would be the same words twice — and on a narrow
                  screen it was the line that wrapped. The rail is aria-hidden,
                  so the date lives here for screen readers only. */}
              <span className="sr-only">
                {start.toLocaleDateString([], {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long'
                })}
                ,{' '}
              </span>
              {fmtTime(start)} – {fmtTime(end)}
            </time>
            <span className={styles.dim}> · {relative(start, now)}</span>
          </p>

          {session.agenda && <p className={styles.agenda}>{session.agenda}</p>}

          {session.status === 'proposed' && (
            <p className={styles.dim}>
              {iProposed
                ? 'Waiting for them to confirm'
                : `${session.proposedBy?.displayName || 'They'} proposed this time`}
            </p>
          )}

          {session.status === 'cancelled' && (
            <p className={styles.dim}>
              Cancelled by {session.cancelledBy?.displayName || 'someone'}
              {session.cancelReason ? ` — ${session.cancelReason}` : ''}
            </p>
          )}

          {session.notes && <blockquote className={styles.notes}>{session.notes}</blockquote>}

          {moving && (
            <div className={styles.inlineForm}>
              <Field label="New time" hint="They will have to confirm it again">
                <Input
                  type="datetime-local"
                  value={moveWhen}
                  min={toLocalInput(new Date(now))}
                  onChange={(e) => setMoveWhen(e.target.value)}
                />
              </Field>
              <div className={styles.inlineActions}>
                <Button size="sm" onClick={() => setMovingId(null)}>
                  Never mind
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !moveWhen}
                  onClick={async () => {
                    const ok = await patch(
                      session,
                      {
                        action: 'reschedule',
                        scheduledFor: new Date(moveWhen).toISOString()
                      },
                      'Moved — waiting on their confirmation'
                    );
                    if (ok) setMovingId(null);
                  }}
                >
                  Move it
                </Button>
              </div>
            </div>
          )}

          {writingNotes && (
            <div className={styles.inlineForm}>
              <Field label="What did you cover?" count={notesText.length} max={2000}>
                <Textarea
                  value={notesText}
                  onChange={(e) => setNotesText(e.target.value)}
                  maxLength={2000}
                  rows={4}
                  autoFocus
                />
              </Field>
              <div className={styles.inlineActions}>
                <Button size="sm" onClick={() => setNotesId(null)}>
                  Never mind
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await patch(session, { notes: notesText }, 'Notes saved');
                    if (ok) setNotesId(null);
                  }}
                >
                  Save notes
                </Button>
              </div>
            </div>
          )}

          {!moving && !writingNotes && (
            <div className={styles.actions}>
              {session.status === 'proposed' && !iProposed && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => patch(session, { action: 'confirm' }, 'Confirmed')}
                >
                  Confirm
                </Button>
              )}

              {isOpen(session) && started && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => patch(session, { action: 'complete' }, 'Marked as done')}
                >
                  Mark as done
                </Button>
              )}

              {/* Only before it starts. Once the time has passed the honest
                  moves are "it happened" or "it didn't", not "move it". */}
              {isOpen(session) && !started && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setMoveWhen(toLocalInput(start));
                    setMovingId(session._id);
                  }}
                >
                  Reschedule
                </Button>
              )}

              {isOpen(session) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCancelReason('');
                    setCancelling(session);
                  }}
                >
                  Cancel
                </Button>
              )}

              {session.status === 'completed' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setNotesText(session.notes || '');
                    setNotesId(session._id);
                  }}
                >
                  {session.notes ? 'Edit notes' : 'Add notes'}
                </Button>
              )}
            </div>
          )}
        </div>
      </li>
    );
  };

  if (loading) {
    return (
      <Card title="Sessions">
        <InlineLoader label="Loading sessions" />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Sessions"
        subtitle={
          upcoming.length > 0
            ? `Next one ${relative(new Date(upcoming[0].scheduledFor), now)}`
            : undefined
        }
        actions={
          active && (
            <Button
              size="sm"
              variant={formOpen ? 'secondary' : 'primary'}
              onClick={() => setFormOpen((open) => !open)}
            >
              {formOpen ? 'Cancel' : 'Propose a time'}
            </Button>
          )
        }
      >
        {formOpen && (
          <form onSubmit={propose} className={styles.form}>
            <Field label="What is this session for?">
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Weekly check-in"
                maxLength={200}
                autoFocus
              />
            </Field>

            <div className={styles.whenRow}>
              <Field label="When" className={styles.grow}>
                <Input
                  type="datetime-local"
                  value={when}
                  min={toLocalInput(new Date(now))}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </Field>

              <Field label="For how long">
                <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
                  {DURATIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Anything to cover?" hint="Optional">
              <Textarea
                value={agenda}
                onChange={(e) => setAgenda(e.target.value)}
                placeholder="What you want to get out of it"
                maxLength={1000}
                rows={2}
              />
            </Field>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!title.trim() || !when}
              >
                {saving ? 'Proposing' : 'Propose'}
              </Button>
            </div>
          </form>
        )}

        {sessions.length === 0 && !formOpen && (
          <EmptyState
            icon={<CalendarIcon size={20} />}
            title="Nothing scheduled"
            description={
              active
                ? 'Either of you can propose a time. The other one confirms it.'
                : 'This mentorship is not active, so nothing new can be scheduled.'
            }
            action={
              active ? (
                <Button variant="primary" onClick={() => setFormOpen(true)}>
                  Propose a time
                </Button>
              ) : undefined
            }
          />
        )}

        {upcoming.length > 0 && <ul className={styles.list}>{upcoming.map(renderSession)}</ul>}
      </Card>

      {past.length > 0 && (
        <Card title="Past sessions" subtitle="What has already happened, and what fell through">
          <ul className={styles.list}>{past.map(renderSession)}</ul>
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        title="Cancel this session?"
        description="They have this time set aside. Cancelling is final — you can propose a new time afterwards."
        confirmLabel="Cancel session"
        destructive
        onConfirm={async () => {
          const target = cancelling;
          setCancelling(null);
          await patch(target, { action: 'cancel', reason: cancelReason }, 'Session cancelled');
          setCancelReason('');
        }}
        onCancel={() => {
          setCancelling(null);
          setCancelReason('');
        }}
      >
        <Textarea
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="Optional — a short reason saves them having to ask"
          maxLength={500}
          rows={3}
          autoFocus
        />
      </ConfirmDialog>
    </>
  );
}
