/**
 * ProgressPage — what your mentorships add up to
 *
 * Goals and sessions have been accumulating real data with nothing reading it
 * back. This is the page that reads it.
 *
 * It is built around one question rather than a wall of numbers: **which
 * relationship needs attention?** A mentor with four students does not want a
 * scoreboard, they want to know which student has gone quiet. So the rows are
 * sorted by how long it has been since a session actually happened — quietest
 * first — and the row you need to act on is the one at the top rather than the
 * one you have to hunt for.
 *
 * The totals above the rows are there for context, not for their own sake.
 * Every one of them is counted live; none is a placeholder.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import Badge, { RoleBadge } from '../components/Badge';
import Progress from '../components/Progress';
import Stat, { StatGrid } from '../components/Stat';
import EmptyState from '../components/EmptyState';
import { PageLoader } from '../components/Loading';
import { HandshakeIcon } from '../components/Icons';
import useNow, { relative } from '../lib/useNow';
import styles from './ProgressPage.module.css';

/** A relationship with no session in this long, and none booked, has stalled. */
const QUIET_DAYS = 21;

const DAY = 86400000;

/**
 * What, if anything, this mentorship needs from you.
 *
 * Returns null when nothing does — a booked session is the answer to the
 * question, so a row with one is not flagged at all. The label carries the
 * meaning on its own; the colour only reinforces it, because a badge that
 * means something only if you can see red is a badge that means nothing to
 * some readers.
 */
function attention(row, now) {
  if (row.nextAt) return null;

  if (!row.lastMetAt) {
    return { variant: 'warning', label: 'Not met yet' };
  }

  const days = Math.floor((now - new Date(row.lastMetAt).getTime()) / DAY);
  if (days >= QUIET_DAYS) {
    return { variant: 'danger', label: `Quiet for ${days} days` };
  }

  return { variant: 'neutral', label: 'Nothing booked' };
}

export default function ProgressPage() {
  const navigate = useNavigate();
  const { authFetch } = useAuth();
  const now = useNow();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch('/api/analytics/me');
        if (res.ok && !stale) setData(await res.json());
      } catch (err) {
        console.error('Error loading analytics:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    return () => {
      stale = true;
    };
  }, [authFetch]);

  if (loading) return <PageLoader label="Counting" />;

  const totals = data?.totals;
  const rows = data?.mentorships || [];

  if (!totals || totals.mentorships.active === 0) {
    return (
      <AppShell title="Progress" subtitle="What your mentorships add up to">
        <Card>
          <EmptyState
            icon={<HandshakeIcon size={20} />}
            title="Nothing to measure yet"
            description="Progress is counted from goals and sessions inside an active mentorship. Once you have one, this page fills itself in."
            action={
              <Button variant="primary" onClick={() => navigate('/mentorships')}>
                Go to Mentorship
              </Button>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const { mentorships, goals, milestones, sessions } = totals;

  // Sessions arranged that actually happened. Only meaningful once something
  // has been arranged at all, so it is hidden rather than shown as 0%.
  const arranged = sessions.completed + sessions.cancelled;
  const keptRate = arranged > 0 ? Math.round((sessions.completed / arranged) * 100) : null;

  const hoursMet = (sessions.minutesMet / 60).toFixed(sessions.minutesMet % 60 === 0 ? 0 : 1);

  const needingAttention = rows.filter((r) => attention(r, now)).length;

  return (
    <AppShell
      title="Progress"
      subtitle={
        needingAttention > 0
          ? `${needingAttention} of ${rows.length} need${needingAttention === 1 ? 's' : ''} a session booked`
          : 'Every mentorship has something in the diary'
      }
    >
      <Card title="Across everything" subtitle="Counted live from your active mentorships">
        <StatGrid min={132}>
          <Stat
            value={mentorships.active}
            label={mentorships.active === 1 ? 'Mentorship' : 'Mentorships'}
            sub={
              mentorships.asMentor > 0 && mentorships.asStudent > 0
                ? `${mentorships.asMentor} as mentor · ${mentorships.asStudent} as student`
                : mentorships.asMentor > 0
                  ? 'as mentor'
                  : 'as student'
            }
          />
          <Stat
            value={milestones.done}
            label="Milestones done"
            sub={`of ${milestones.total}`}
          />
          <Stat
            value={goals.completed}
            label="Goals completed"
            sub={`of ${goals.total}`}
          />
          <Stat value={sessions.completed} label="Sessions met" sub={`${hoursMet} hours`} />
          {keptRate !== null && (
            <Stat value={`${keptRate}%`} label="Sessions kept" sub={`of ${arranged} arranged`} />
          )}
        </StatGrid>

        {milestones.total > 0 && (
          <div className={styles.overall}>
            <Progress
              done={milestones.done}
              total={milestones.total}
              label="Overall milestone progress"
            />
          </div>
        )}
      </Card>

      <Card
        title="By mentorship"
        subtitle="Quietest first — the one that needs you is at the top"
        padded={false}
      >
        <ul className={styles.list}>
          {rows.map((row) => {
            const flag = attention(row, now);

            return (
              <li key={row._id} className={styles.row}>
                <Avatar
                  src={row.other?.photoURL}
                  name={row.other?.displayName}
                  size="sm"
                />

                <div className={styles.body}>
                  <div className={styles.topLine}>
                    <span className={styles.nameRow}>
                      <button
                        type="button"
                        className={styles.name}
                        onClick={() => navigate(`/mentorships/${row._id}`)}
                      >
                        {row.other?.displayName || 'Unknown'}
                      </button>
                      <RoleBadge role={row.other?.role} />
                      <span className={styles.side}>
                        {row.isMentor ? 'you mentor them' : 'they mentor you'}
                      </span>
                    </span>

                    {flag && <Badge variant={flag.variant}>{flag.label}</Badge>}
                  </div>

                  <p className={styles.topic}>{row.topic}</p>

                  <Progress
                    done={row.milestones.done}
                    total={row.milestones.total}
                    showCount
                  />

                  {/* The facts behind the meter, in one line. Written out
                      rather than shown as more tiles: at this size a row of
                      four numbers reads as decoration, a sentence reads. */}
                  <p className={styles.facts}>
                    {row.goals.total === 0
                      ? 'No goals set'
                      : `${row.goals.completed} of ${row.goals.total} goal${row.goals.total === 1 ? '' : 's'} complete`}
                    {' · '}
                    {row.sessions.completed === 0
                      ? 'no sessions yet'
                      : `${row.sessions.completed} session${row.sessions.completed === 1 ? '' : 's'} met`}
                    {/* "most recently" rather than "last", because
                        `relative` already says "last month" for anything that
                        old — and "last last month" is what that produced. */}
                    {row.lastMetAt && (
                      <>
                        {', most recently '}
                        <time dateTime={new Date(row.lastMetAt).toISOString()}>
                          {relative(new Date(row.lastMetAt), now)}
                        </time>
                      </>
                    )}
                    {row.nextAt && (
                      <>
                        {' · next '}
                        <time dateTime={new Date(row.nextAt).toISOString()}>
                          {relative(new Date(row.nextAt), now)}
                        </time>
                      </>
                    )}
                  </p>
                </div>

                <div className={styles.actions}>
                  <Button size="sm" onClick={() => navigate(`/mentorships/${row._id}`)}>
                    Open
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </AppShell>
  );
}
