/**
 * MentorshipDetailPage - one relationship, and the goals inside it
 *
 * The screen the mentorship model existed to make possible. Goals belong to a
 * mentorship rather than to a person, so this is the only place they can
 * sensibly live: "Priya's goals" is ambiguous once she has two mentors,
 * "the goals of this mentorship" never is.
 *
 * The asymmetry is the point of the feature and is visible in the UI:
 * **the mentor sets goals, either party ticks milestones off.** The student
 * does the work and reports it; the mentor can correct a mistake without
 * having to ask. The server enforces both halves.
 *
 * Sessions hang off the bottom of the same page, from their own component.
 * They are deliberately the opposite way round — anyone may propose a time,
 * and the other person confirms it — because asking for time is not a
 * directive the way setting a goal is.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import Badge, { RoleBadge, VerifiedBadge } from '../components/Badge';
import { Field, Input, Textarea } from '../components/Field';
import Progress from '../components/Progress';
import Sessions from '../components/Sessions';
import EmptyState from '../components/EmptyState';
import { InlineLoader, PageLoader } from '../components/Loading';
import { useToast } from '../components/Toast';
import { HandshakeIcon } from '../components/Icons';
import styles from './MentorshipDetailPage.module.css';

export default function MentorshipDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();

  const [mentorship, setMentorship] = useState(null);
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // New-goal form
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [milestoneText, setMilestoneText] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);

      try {
        // There is no GET for a single mentorship — the list endpoint already
        // returns everything you are part of, and picking from it keeps the
        // server surface smaller than adding a route for one object.
        const [mRes, gRes] = await Promise.all([
          authFetch('/api/mentorships'),
          authFetch(`/api/mentorships/${id}/goals`)
        ]);

        if (mRes.ok) {
          const mine = await mRes.json();
          const found = mine.find((m) => m._id === id);
          if (found) setMentorship(found);
          else setNotFound(true);
        }

        if (gRes.ok) setGoals(await gRes.json());
        else setNotFound(true);
      } catch (err) {
        console.error('Error loading mentorship:', err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [id, authFetch]);

  /** Live goal updates — the other party ticking something shows up here. */
  useEffect(() => {
    if (!socket) return;

    const handleGoal = (goal) => {
      if (goal.mentorship !== id) return;

      setGoals((prev) => {
        const exists = prev.some((g) => g._id === goal._id);
        return exists
          ? prev.map((g) => (g._id === goal._id ? goal : g))
          : [goal, ...prev];
      });
    };

    socket.on('goal-updated', handleGoal);
    return () => socket.off('goal-updated', handleGoal);
  }, [socket, id]);

  const isMentor = mentorship && (mentorship.mentor?._id || mentorship.mentor) === dbUser?._id;
  const other = mentorship ? (isMentor ? mentorship.student : mentorship.mentor) : null;

  const toggleMilestone = useCallback(
    async (goal, milestone) => {
      setBusyId(milestone._id);

      try {
        const res = await authFetch(
          `/api/goals/${goal._id}/milestones/${milestone._id}`,
          { method: 'PATCH', body: JSON.stringify({ done: !milestone.done }) }
        );

        if (res.ok) {
          const updated = await res.json();
          setGoals((prev) => prev.map((g) => (g._id === updated._id ? updated : g)));

          // Only announce the transition that matters. A toast on every tick
          // would be noise on a ten-milestone goal.
          if (updated.status === 'completed' && goal.status !== 'completed') {
            toast.success(`"${updated.title}" is complete.`);
          }
        } else {
          const body = await res.json().catch(() => ({}));
          toast.error(body.error || 'Could not update that milestone');
        }
      } catch (err) {
        console.error('Error toggling milestone:', err);
        toast.error('Could not reach the server');
      } finally {
        setBusyId(null);
      }
    },
    [authFetch, toast]
  );

  const createGoal = async (e) => {
    e.preventDefault();
    setCreating(true);

    try {
      // One milestone per line — the least fiddly way to enter a short list,
      // and it matches how someone would write it down anyway.
      const milestones = milestoneText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const res = await authFetch(`/api/mentorships/${id}/goals`, {
        method: 'POST',
        body: JSON.stringify({ title, description, milestones })
      });

      if (res.ok) {
        const goal = await res.json();
        setGoals((prev) => [goal, ...prev]);
        setTitle('');
        setDescription('');
        setMilestoneText('');
        setFormOpen(false);
        toast.success('Goal set');
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not create that goal');
      }
    } catch (err) {
      console.error('Error creating goal:', err);
      toast.error('Could not reach the server');
    } finally {
      setCreating(false);
    }
  };

  const setArchived = async (goal, archived) => {
    setBusyId(goal._id);

    try {
      const res = await authFetch(`/api/goals/${goal._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived })
      });

      if (res.ok) {
        const updated = await res.json();
        setGoals((prev) => prev.map((g) => (g._id === updated._id ? updated : g)));
        toast.success(archived ? 'Goal archived' : 'Goal restored');
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not update that goal');
      }
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <PageLoader label="Loading mentorship" />;

  if (notFound || !mentorship) {
    return (
      <AppShell title="Mentorship" backTo="/mentorships">
        <Card>
          <EmptyState
            icon={<HandshakeIcon size={20} />}
            title="This mentorship could not be found"
            description="It may have been removed, or it may not be yours."
            action={
              <Button variant="secondary" onClick={() => navigate('/mentorships')}>
                Back to mentorships
              </Button>
            }
          />
        </Card>
      </AppShell>
    );
  }

  // Overall progress counts every milestone across every live goal, so one
  // finished goal among four does not read as "done".
  const live = goals.filter((g) => g.status !== 'archived');
  const totalMilestones = live.reduce((n, g) => n + g.milestones.length, 0);
  const doneMilestones = live.reduce(
    (n, g) => n + g.milestones.filter((m) => m.done).length,
    0
  );

  const canSetGoals = isMentor && mentorship.status === 'active';

  return (
    <AppShell
      title={other?.displayName || 'Mentorship'}
      subtitle={mentorship.topic}
      backTo="/mentorships"
      actions={
        canSetGoals && (
          <Button
            size="sm"
            variant={formOpen ? 'secondary' : 'primary'}
            onClick={() => setFormOpen((open) => !open)}
          >
            {formOpen ? 'Cancel' : 'New goal'}
          </Button>
        )
      }
    >
      {/* Who and what */}
      <Card>
        <div className={styles.header}>
          <Avatar src={other?.photoURL} name={other?.displayName} size="lg" />

          <div className={styles.headerText}>
            <span className={styles.nameRow}>
              <button
                type="button"
                className={styles.name}
                onClick={() => other?._id && navigate(`/users/${other._id}`)}
              >
                {other?.displayName}
              </button>
              <RoleBadge role={other?.role} />
              <VerifiedBadge user={other} />
            </span>
            <span className={styles.relation}>
              {isMentor ? 'You mentor them' : 'They mentor you'} ·{' '}
              {mentorship.status === 'active' ? 'Active' : mentorship.status}
            </span>
          </div>

          <Button size="sm" onClick={() => navigate(`/chat/${other._id}`)}>
            Message
          </Button>
        </div>

        {live.length > 0 && (
          <div className={styles.overall}>
            <Progress
              done={doneMilestones}
              total={totalMilestones}
              label="Overall progress"
            />
          </div>
        )}
      </Card>

      {/* New goal — mentors only, and only while the mentorship is active */}
      {canSetGoals && formOpen && (
        <Card title="New goal">
          <form onSubmit={createGoal} className={styles.form}>
            <Field label="What are they working towards?">
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Be ready for backend interviews"
                maxLength={200}
                autoFocus
              />
            </Field>

            <Field label="Any detail?" hint="Optional">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What good looks like, or where to start"
                maxLength={1000}
                rows={2}
              />
            </Field>

            <Field
              label="Milestones"
              hint="One per line. These are what get ticked off."
            >
              <Textarea
                value={milestoneText}
                onChange={(e) => setMilestoneText(e.target.value)}
                placeholder={'Arrays and strings\nLinked lists\nTrees and graphs\nMock interview'}
                rows={5}
              />
            </Field>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={creating}
                disabled={!title.trim()}
              >
                {creating ? 'Saving' : 'Set goal'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Goals */}
      {goals.length === 0 ? (
        <Card>
          <EmptyState
            title="No goals yet"
            description={
              isMentor
                ? 'Set what they are working towards, and break it into milestones they can tick off.'
                : 'Your mentor has not set any goals yet.'
            }
            action={
              canSetGoals ? (
                <Button variant="primary" onClick={() => setFormOpen(true)}>
                  Set the first goal
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        goals.map((goal) => {
          const done = goal.milestones.filter((m) => m.done).length;
          const archived = goal.status === 'archived';

          return (
            <Card
              key={goal._id}
              className={archived ? styles.archivedCard : undefined}
              title={goal.title}
              subtitle={goal.description || undefined}
              actions={
                <>
                  {goal.status === 'completed' && <Badge variant="success">Complete</Badge>}
                  {archived && <Badge variant="neutral">Archived</Badge>}
                  {isMentor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === goal._id}
                      onClick={() => setArchived(goal, !archived)}
                    >
                      {archived ? 'Restore' : 'Archive'}
                    </Button>
                  )}
                </>
              }
            >
              <Progress done={done} total={goal.milestones.length} showCount />

              {goal.milestones.length > 0 && (
                <ul className={styles.milestones}>
                  {goal.milestones.map((m) => (
                    <li key={m._id} className={styles.milestone}>
                      {/* A real checkbox: keyboard-operable and announced as
                          checked/unchecked without any extra ARIA. */}
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={m.done}
                          disabled={archived || busyId === m._id}
                          onChange={() => toggleMilestone(goal, m)}
                          className={styles.checkbox}
                        />
                        <span className={m.done ? styles.doneText : undefined}>
                          {m.title}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}

      {/* Below the goals on purpose. Goals are what the page is for; the
          schedule is a detail of one relationship. "When am I next meeting
          anyone?" is a different question and is answered on the mentorships
          list, where it does not need this page open to see. */}
      <Sessions mentorshipId={id} active={mentorship.status === 'active'} />
    </AppShell>
  );
}
