/**
 * MentorshipsPage - every relationship you are part of, on either side
 *
 * One page rather than separate student and mentor views, because the two
 * are not exclusive: a mentor can be someone else's student, and splitting
 * the screen by role would hide half of what a person has. The sections
 * render only when they have something in them, so a pure student never sees
 * "Students you mentor" and a pure mentor never sees an empty "Your mentors".
 *
 * Requests waiting on YOU come first — that is the only part of this page
 * that is work rather than reference. Your next sessions come second, pulled
 * from every mentorship at once: "when am I next meeting anyone?" is a
 * question about your week, not about one relationship, and answering it
 * should not mean opening three pages and comparing dates.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import Badge, { RoleBadge, VerifiedBadge } from '../components/Badge';
import { Textarea } from '../components/Field';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { InlineLoader } from '../components/Loading';
import { useToast } from '../components/Toast';
import { HandshakeIcon, CalendarIcon } from '../components/Icons';
import styles from './MentorshipsPage.module.css';

export default function MentorshipsPage() {
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();

  const [mentorships, setMentorships] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  // { mentorship, action } while a dialog is open
  const [pending, setPending] = useState(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await authFetch('/api/mentorships');
        if (res.ok) setMentorships(await res.json());
      } catch (err) {
        console.error('Error loading mentorships:', err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [authFetch]);

  /**
   * Upcoming sessions, reloaded rather than patched in place.
   *
   * The socket payload for a session carries its mentorship as a bare id,
   * because the detail page already knows which relationship it is looking
   * at. This page needs the names, and it needs the list re-sorted and
   * re-trimmed to ten whenever anything moves. Refetching does all of that
   * and costs one small request on an event that fires a handful of times a
   * week.
   */
  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch('/api/sessions/upcoming');
        if (res.ok && !stale) setUpcoming(await res.json());
      } catch (err) {
        console.error('Error loading upcoming sessions:', err);
      }
    };

    load();
    if (!socket) return undefined;

    // The same loader is the socket handler: every session change reloads.
    socket.on('session-updated', load);
    return () => {
      stale = true;
      socket.off('session-updated', load);
    };
  }, [authFetch, socket]);

  /**
   * Live updates. The server emits to both parties on every transition, so a
   * request accepted in another window moves out of the queue here without a
   * refresh — and a student watching sees the answer arrive.
   */
  useEffect(() => {
    if (!socket) return;

    const handleUpdate = (updated) => {
      setMentorships((prev) => {
        const exists = prev.some((m) => m._id === updated._id);
        // A brand-new request arrives as an update the recipient has never
        // seen, so it has to be prepended rather than merged.
        return exists
          ? prev.map((m) => (m._id === updated._id ? updated : m))
          : [updated, ...prev];
      });
    };

    socket.on('mentorship-updated', handleUpdate);
    return () => socket.off('mentorship-updated', handleUpdate);
  }, [socket]);

  const act = useCallback(
    async (mentorship, action, actionNote = '') => {
      setPending(null);
      setBusyId(mentorship._id);

      try {
        const res = await authFetch(`/api/mentorships/${mentorship._id}`, {
          method: 'PATCH',
          body: JSON.stringify({ action, note: actionNote })
        });

        if (res.ok) {
          const updated = await res.json();
          setMentorships((prev) =>
            prev.map((m) => (m._id === updated._id ? updated : m))
          );

          toast.success(
            action === 'accept'
              ? `You are now mentoring ${updated.student.displayName}.`
              : action === 'decline'
                ? 'Request declined.'
                : 'Mentorship ended.'
          );
        } else {
          const body = await res.json().catch(() => ({}));
          toast.error(body.error || 'Could not update that mentorship');
        }
      } catch (err) {
        console.error('Error updating mentorship:', err);
        toast.error('Could not reach the server');
      } finally {
        setNote('');
        setBusyId(null);
      }
    },
    [authFetch, toast]
  );

  const me = dbUser?._id;
  const iAmMentor = (m) => (m.mentor?._id || m.mentor) === me;

  // Split once, read four times.
  const incoming = mentorships.filter((m) => m.status === 'pending' && iAmMentor(m));
  const awaiting = mentorships.filter((m) => m.status === 'pending' && !iAmMentor(m));
  const myMentors = mentorships.filter((m) => m.status === 'active' && !iAmMentor(m));
  const myStudents = mentorships.filter((m) => m.status === 'active' && iAmMentor(m));
  const past = mentorships.filter((m) => ['declined', 'ended'].includes(m.status));

  const formatDate = (value) =>
    value ? new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';

  /** "Thu 12 Mar, 4:00 PM" — enough to plan around without a full date. */
  const formatWhen = (value) => {
    const d = new Date(value);
    return `${d.toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };

  /** One person's row: avatar, name, badges, and what the relationship is about. */
  const Person = ({ user, topic, when, children }) => (
    <li className={styles.row}>
      <Avatar src={user?.photoURL} name={user?.displayName} size="sm" />

      <div className={styles.who}>
        <span className={styles.nameRow}>
          <button
            type="button"
            className={styles.name}
            onClick={() => user?._id && navigate(`/users/${user._id}`)}
          >
            {user?.displayName || 'Unknown'}
          </button>
          <RoleBadge role={user?.role} />
          <VerifiedBadge user={user} />
        </span>
        <span className={styles.topic}>
          {topic}
          {when && <span className={styles.when}> · {when}</span>}
        </span>
      </div>

      <div className={styles.actions}>{children}</div>
    </li>
  );

  return (
    <AppShell
      title="Mentorship"
      subtitle={
        loading
          ? undefined
          : incoming.length > 0
            ? `${incoming.length} request${incoming.length === 1 ? '' : 's'} waiting on you`
            : 'Your mentors and students'
      }
    >
      {loading ? (
        <Card>
          <InlineLoader label="Loading mentorships" />
        </Card>
      ) : mentorships.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HandshakeIcon size={20} />}
            title="No mentorships yet"
            description="Find someone on the Messages list, open their profile, and ask them to mentor you."
            action={
              <Button variant="primary" onClick={() => navigate('/users')}>
                Browse people
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Work first */}
          {incoming.length > 0 && (
            <Card title="Requests for you" subtitle="Someone has asked you to mentor them" padded={false}>
              <ul className={styles.list}>
                {incoming.map((m) => (
                  <li key={m._id} className={styles.requestRow}>
                    <div className={styles.requestHead}>
                      <Avatar src={m.student?.photoURL} name={m.student?.displayName} size="sm" />
                      <div className={styles.who}>
                        <span className={styles.nameRow}>
                          <button
                            type="button"
                            className={styles.name}
                            onClick={() => navigate(`/users/${m.student._id}`)}
                          >
                            {m.student?.displayName}
                          </button>
                          <RoleBadge role={m.student?.role} />
                        </span>
                        <span className={styles.when}>Asked {formatDate(m.requestedAt)}</span>
                      </div>
                    </div>

                    <p className={styles.topicLead}>
                      Wants help with <strong>{m.topic}</strong>
                    </p>

                    {m.message && <blockquote className={styles.message}>{m.message}</blockquote>}

                    <div className={styles.requestActions}>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === m._id}
                        onClick={() => {
                          setNote('');
                          setPending({ mentorship: m, action: 'decline' });
                        }}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busyId === m._id}
                        onClick={() => act(m, 'accept')}
                      >
                        Accept
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {upcoming.length > 0 && (
            <Card
              title="Coming up"
              subtitle="Your next sessions, across every mentorship"
              padded={false}
            >
              <ul className={styles.list}>
                {upcoming.map((s) => {
                  const m = s.mentorship;
                  const other = (m?.mentor?._id || m?.mentor) === me ? m?.student : m?.mentor;

                  return (
                    <li key={s._id} className={styles.row}>
                      <span className={styles.sessionIcon} aria-hidden="true">
                        <CalendarIcon size={16} />
                      </span>

                      <div className={styles.who}>
                        <span className={styles.nameRow}>
                          <span className={styles.sessionTitle}>{s.title}</span>
                          {s.status === 'proposed' ? (
                            <Badge variant="warning">Needs confirming</Badge>
                          ) : (
                            <Badge variant="success">Confirmed</Badge>
                          )}
                        </span>
                        <span className={styles.topic}>
                          {formatWhen(s.scheduledFor)}
                          <span className={styles.when}>
                            {' '}
                            · with {other?.displayName || 'someone'}
                          </span>
                        </span>
                      </div>

                      <div className={styles.actions}>
                        <Button
                          size="sm"
                          onClick={() => navigate(`/mentorships/${m?._id || m}`)}
                        >
                          Open
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {myMentors.length > 0 && (
            <Card title="Your mentors" padded={false}>
              <ul className={styles.list}>
                {myMentors.map((m) => (
                  <Person key={m._id} user={m.mentor} topic={m.topic}>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => navigate(`/mentorships/${m._id}`)}
                    >
                      Open
                    </Button>
                    <Button size="sm" onClick={() => navigate(`/chat/${m.mentor._id}`)}>
                      Message
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === m._id}
                      onClick={() => {
                        setNote('');
                        setPending({ mentorship: m, action: 'end' });
                      }}
                    >
                      End
                    </Button>
                  </Person>
                ))}
              </ul>
            </Card>
          )}

          {myStudents.length > 0 && (
            <Card title="You mentor" padded={false}>
              <ul className={styles.list}>
                {myStudents.map((m) => (
                  <Person key={m._id} user={m.student} topic={m.topic}>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => navigate(`/mentorships/${m._id}`)}
                    >
                      Open
                    </Button>
                    <Button size="sm" onClick={() => navigate(`/chat/${m.student._id}`)}>
                      Message
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === m._id}
                      onClick={() => {
                        setNote('');
                        setPending({ mentorship: m, action: 'end' });
                      }}
                    >
                      End
                    </Button>
                  </Person>
                ))}
              </ul>
            </Card>
          )}

          {awaiting.length > 0 && (
            <Card title="Waiting for a reply" padded={false}>
              <ul className={styles.list}>
                {awaiting.map((m) => (
                  <Person
                    key={m._id}
                    user={m.mentor}
                    topic={m.topic}
                    when={`asked ${formatDate(m.requestedAt)}`}
                  >
                    <Badge variant="warning">Pending</Badge>
                  </Person>
                ))}
              </ul>
            </Card>
          )}

          {/* Kept rather than hidden: a declined request is the reason you
              cannot see a pending one, and an ended mentorship is history
              worth having. */}
          {past.length > 0 && (
            <Card title="Past" subtitle="Declined requests and finished mentorships" padded={false}>
              <ul className={styles.list}>
                {past.map((m) => {
                  const other = iAmMentor(m) ? m.student : m.mentor;

                  return (
                    <Person key={m._id} user={other} topic={m.topic}>
                      <Badge variant="neutral">
                        {m.status === 'declined' ? 'Declined' : 'Ended'}
                      </Badge>
                    </Person>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(pending)}
        title={
          pending?.action === 'decline'
            ? `Decline ${pending?.mentorship?.student?.displayName || ''}?`
            : 'End this mentorship?'
        }
        description={
          pending?.action === 'decline'
            ? 'They will see your answer. They can ask again later if things change.'
            : 'Either of you can end a mentorship. The record is kept, and a new one can be started later.'
        }
        confirmLabel={pending?.action === 'decline' ? 'Decline' : 'End mentorship'}
        destructive
        onConfirm={() => act(pending.mentorship, pending.action, note)}
        onCancel={() => {
          setPending(null);
          setNote('');
        }}
      >
        {pending?.action === 'decline' && (
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional — a short reason helps them ask better next time"
            maxLength={500}
            rows={3}
            autoFocus
          />
        )}
      </ConfirmDialog>
    </AppShell>
  );
}
