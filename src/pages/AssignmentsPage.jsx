/**
 * AssignmentsPage — the whole class at once
 *
 * The mentorship page shows one student's work. This page is the other axis:
 * one assignment, every student it went to — which is what "like Google
 * Classroom" actually means, and the only place "4 of 6 handed in" can live,
 * because it spans many mentorships.
 *
 * It is role-aware rather than two pages, because one person can be on both
 * sides: a mentor with a mentor of their own sees the work they set *and* the
 * work set for them.
 *
 * Students never see anyone else's hand-in here. Their half of the page is
 * built from their own submissions only, and the per-assignment view that
 * lists every student is refused by the server for anyone but the mentor who
 * set it.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Button from '../components/Button';
import Badge from '../components/Badge';
import Avatar from '../components/Avatar';
import Progress from '../components/Progress';
import ConfirmDialog from '../components/ConfirmDialog';
import { Field, Input, Textarea, Select } from '../components/Field';
import EmptyState from '../components/EmptyState';
import { PageLoader, InlineLoader } from '../components/Loading';
import { useToast } from '../components/Toast';
import { ClipboardIcon } from '../components/Icons';
import SubmissionRow from '../components/SubmissionRow';
import { canMentor } from '../lib/roles';
import useNow, { relative } from '../lib/useNow';
import styles from './AssignmentsPage.module.css';

function toLocalInput(date) {
  const ms = date.getTime() - date.getTimezoneOffset() * 60000;
  return new Date(ms).toISOString().slice(0, 16);
}

function defaultDue() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(17, 0, 0, 0);
  return toLocalInput(d);
}

const fmtDue = (d) =>
  `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

export default function AssignmentsPage() {
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();
  const now = useNow();

  const iCanMentor = canMentor(dbUser?.role);
  const myId = dbUser?._id;

  const [data, setData] = useState({ set: [], mine: [] });
  const [students, setStudents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupNote, setGroupNote] = useState('');
  const [loading, setLoading] = useState(true);

  // Set-an-assignment form
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [picked, setPicked] = useState(new Set());
  const [saving, setSaving] = useState(false);

  // The one assignment expanded into its per-student view, and its data
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [withdrawing, setWithdrawing] = useState(null);

  // Bumped to force a reload from an event handler. Every reload goes through
  // this rather than through a shared loader, which keeps every setState out
  // of an effect body — the one place React's rules object to.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const loadDetail = useCallback(
    async (id) => {
      setDetailLoading(true);
      try {
        const res = await authFetch(`/api/assignments/${id}`);
        if (res.ok) setDetail(await res.json());
      } catch (err) {
        console.error('Error loading assignment:', err);
      } finally {
        setDetailLoading(false);
      }
    },
    [authFetch]
  );

  /**
   * The page's data: your assignments from both sides of the desk, plus — for
   * a mentor — the students and groups the recipient picker is built from.
   * No new endpoints: mentorships and groups already return their people.
   */
  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const requests = [authFetch('/api/assignments')];
        if (iCanMentor) {
          requests.push(authFetch('/api/mentorships?status=active'));
          requests.push(authFetch(`/api/groups?userId=${myId}`));
        }

        const [aRes, mRes, gRes] = await Promise.all(requests);
        if (stale) return;

        if (aRes.ok) setData(await aRes.json());
        if (mRes?.ok) {
          const all = await mRes.json();
          setStudents(
            all
              .filter((m) => (m.mentor?._id || m.mentor) === myId)
              .sort((a, b) =>
                (a.student?.displayName || '').localeCompare(b.student?.displayName || '')
              )
          );
        }
        if (gRes?.ok) setGroups(await gRes.json());
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
  }, [authFetch, iCanMentor, myId, version]);

  // Any change to an assignment you are part of: refresh the list, and the
  // expanded view if it is that one.
  useEffect(() => {
    if (!socket) return undefined;

    const handle = ({ assignmentId }) => {
      refresh();
      if (assignmentId === openId) loadDetail(openId);
    };

    socket.on('assignment-changed', handle);
    return () => socket.off('assignment-changed', handle);
  }, [socket, refresh, loadDetail, openId]);

  const toggleOpen = (id) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
    } else {
      setOpenId(id);
      setDetail(null);
      loadDetail(id);
    }
  };

  const togglePick = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allPicked = students.length > 0 && picked.size === students.length;

  /**
   * Groups are a way to PICK recipients, never the recipient.
   *
   * Anyone can join a group here, and other mentors are members too, so a
   * group's members are not necessarily this mentor's students. If the group
   * itself received work, a student could opt into another mentor's
   * assignments just by joining, and a mentor could set work for people who
   * never agreed to be mentored by them. So choosing a group ticks only the
   * members who ARE your students, and the note says who was left out. The
   * server validates the final list exactly as it would a hand-ticked one.
   */
  const studentIdOf = (m) => String(m.student?._id || m.student);
  const myStudentIds = new Set(students.map(studentIdOf));

  const groupOptions = groups
    .map((g) => {
      const memberIds = (g.members || []).map((u) => String(u._id || u));
      const mine = students.filter((m) => memberIds.includes(studentIdOf(m)));
      const others = memberIds.filter(
        (id) => id !== String(myId) && !myStudentIds.has(id)
      ).length;
      return { group: g, mine, others };
    })
    .filter((o) => o.mine.length > 0);

  const pickGroup = (groupId) => {
    const o = groupOptions.find((x) => String(x.group._id) === String(groupId));
    if (!o) return;

    // Adds to what is already ticked rather than replacing it, so two groups
    // can be combined and a hand-picked extra is not lost.
    setPicked((prev) => new Set([...prev, ...o.mine.map((m) => m._id)]));
    setGroupNote(
      `Ticked ${o.mine.length} from “${o.group.name}”.` +
        (o.others > 0
          ? ` ${o.others} other member${o.others === 1 ? ' is' : 's are'} not your student${o.others === 1 ? '' : 's'}, so they will not get it.`
          : '')
    );
  };

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
          mentorshipIds: [...picked]
        })
      });

      if (res.ok) {
        const count = picked.size;
        setTitle('');
        setInstructions('');
        setDue(defaultDue());
        setPicked(new Set());
        setGroupNote('');
        setFormOpen(false);
        toast.success(`Set for ${count} student${count === 1 ? '' : 's'}`);
        refresh();
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

  const withdraw = async (a) => {
    try {
      const res = await authFetch(`/api/assignments/${a._id}`, { method: 'DELETE' });
      if (res.ok) {
        if (openId === a._id) {
          setOpenId(null);
          setDetail(null);
        }
        toast.success('Assignment withdrawn');
        refresh();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not withdraw that');
      }
    } catch (err) {
      console.error('Error withdrawing:', err);
      toast.error('Could not reach the server');
    }
  };

  if (loading) return <PageLoader label="Loading assignments" />;

  const toReview = data.set.reduce((n, a) => n + a.summary.toReview, 0);
  // A draft is not handed in, so it still counts as owed.
  const toHandIn = data.mine.filter((s) =>
    ['assigned', 'draft', 'changes-requested'].includes(s.status)
  ).length;

  const subtitle =
    iCanMentor && toReview > 0
      ? `${toReview} hand-in${toReview === 1 ? '' : 's'} waiting on you`
      : toHandIn > 0
        ? `${toHandIn} still to hand in`
        : 'Work set, handed in and reviewed';

  // Students see their own work; a mentor sees it too if they have a mentor.
  const showMine = !iCanMentor || data.mine.length > 0;

  return (
    <AppShell
      title="Assignments"
      subtitle={subtitle}
      actions={
        iCanMentor &&
        students.length > 0 && (
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
      {/* ---------------- Mentor: set work for several students ---------------- */}
      {iCanMentor && formOpen && (
        <Card title="Set an assignment" subtitle="One brief, sent to every student you tick">
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

            {/* A real fieldset of checkboxes: keyboard-operable and announced
                as a group, which a list of clickable cards would not be. */}
            <fieldset className={styles.recipients}>
              {/* Most work goes to everyone, so Select all is a real button
                  rather than a text link that is easy to miss. */}
              <legend className={styles.legend}>
                Send to
                <Button
                  type="button"
                  size="sm"
                  variant={allPicked ? 'ghost' : 'secondary'}
                  onClick={() =>
                    setPicked(allPicked ? new Set() : new Set(students.map((m) => m._id)))
                  }
                >
                  {allPicked
                    ? 'Clear all'
                    : students.length === 1
                      ? 'Select'
                      : `Select all ${students.length}`}
                </Button>
              </legend>

              {groupOptions.length > 0 && (
                <div className={styles.groupPick}>
                  <Select
                    value=""
                    onChange={(e) => pickGroup(e.target.value)}
                    aria-label="Tick your students from a group"
                  >
                    <option value="">Tick your students from a group…</option>
                    {groupOptions.map((o) => (
                      <option key={o.group._id} value={o.group._id}>
                        {o.group.name} — {o.mine.length} of your student{o.mine.length === 1 ? '' : 's'}
                      </option>
                    ))}
                  </Select>
                  {groupNote && <p className={styles.groupNote}>{groupNote}</p>}
                </div>
              )}

              <div className={styles.recipientGrid}>
                {students.map((m) => (
                  <label key={m._id} className={styles.recipient}>
                    <input
                      type="checkbox"
                      checked={picked.has(m._id)}
                      onChange={() => togglePick(m._id)}
                      className={styles.checkbox}
                    />
                    <Avatar src={m.student?.photoURL} name={m.student?.displayName} size="sm" />
                    <span className={styles.recipientText}>
                      <span className={styles.recipientName}>{m.student?.displayName}</span>
                      <span className={styles.recipientTopic}>{m.topic}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!title.trim() || !due || picked.size === 0}
              >
                {saving
                  ? 'Setting'
                  : picked.size > 0
                    ? `Set for ${picked.size} student${picked.size === 1 ? '' : 's'}`
                    : 'Pick at least one student'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* ---------------- Mentor: what you have set ---------------- */}
      {iCanMentor && (
        <Card title="Work you set" subtitle={data.set.length ? undefined : 'Nothing yet'}>
          {data.set.length === 0 ? (
            <EmptyState
              icon={<ClipboardIcon size={20} />}
              title={students.length ? 'Nothing set yet' : 'No students yet'}
              description={
                students.length
                  ? 'Set one brief and send it to as many of your students as you like. Each hands in separately.'
                  : 'Take someone on as a student from their profile, and you can set them work here.'
              }
              action={
                students.length ? (
                  <Button variant="primary" onClick={() => setFormOpen(true)}>
                    Set an assignment
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className={styles.list}>
              {data.set.map((a) => {
                const s = a.summary;
                const isOpen = openId === a._id;
                const dueDate = new Date(a.dueAt);

                return (
                  <li key={a._id} className={styles.setRow}>
                    <div className={styles.setHead}>
                      <div className={styles.setText}>
                        <h3 className={styles.setTitle}>{a.title}</h3>
                        <p className={styles.setDue}>
                          Due <time dateTime={dueDate.toISOString()}>{fmtDue(dueDate)}</time>
                          <span className={styles.dim}> · {relative(dueDate, now)}</span>
                        </p>
                      </div>

                      {/* What the mentor needs to act on, in words, before
                          the bar — the bar is context, these are the jobs. */}
                      <div className={styles.flags}>
                        {s.toReview > 0 && <Badge variant="accent">{s.toReview} to review</Badge>}
                        {s.overdue > 0 && <Badge variant="danger">{s.overdue} overdue</Badge>}
                        {s.drafts > 0 && (
                          <Badge variant="warning">{s.drafts} attached, not handed in</Badge>
                        )}
                        {s.total > 0 && s.accepted === s.total && (
                          <Badge variant="success">All accepted</Badge>
                        )}
                      </div>
                    </div>

                    <Progress
                      done={s.handedIn}
                      total={s.total}
                      label={`${s.handedIn} of ${s.total} handed in`}
                      showCount={false}
                    />

                    <div className={styles.setActions}>
                      <Button
                        size="sm"
                        variant={isOpen ? 'secondary' : 'primary'}
                        onClick={() => toggleOpen(a._id)}
                        aria-expanded={isOpen}
                      >
                        {isOpen ? 'Hide students' : 'See each student'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setWithdrawing(a)}>
                        Withdraw
                      </Button>
                    </div>

                    {isOpen && (
                      <div className={styles.detail}>
                        {detailLoading && !detail ? (
                          <InlineLoader label="Loading hand-ins" />
                        ) : (
                          detail && (
                            <>
                              {detail.instructions && (
                                <p className={styles.instructions}>{detail.instructions}</p>
                              )}
                              <ul className={styles.list}>
                                {detail.submissions.map((sub) => (
                                  <SubmissionRow
                                    key={sub._id}
                                    submission={sub}
                                    viewer="mentor"
                                    showStudent
                                    dueAt={detail.dueAt}
                                    onChanged={() => {
                                      loadDetail(a._id);
                                      refresh();
                                    }}
                                  />
                                ))}
                              </ul>
                            </>
                          )
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {/* ---------------- Student: your own work ---------------- */}
      {showMine && (
        <Card
          title={iCanMentor ? 'Work set for you' : 'Your work'}
          subtitle={data.mine.length ? undefined : 'Nothing set yet'}
        >
          {data.mine.length === 0 ? (
            <EmptyState
              icon={<ClipboardIcon size={20} />}
              title="Nothing to hand in"
              description="When a mentor sets you work, it appears here with its deadline."
            />
          ) : (
            <ul className={styles.list}>
              {data.mine.map((sub) => (
                <SubmissionRow
                  key={sub._id}
                  submission={sub}
                  viewer="student"
                  showAssignment
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(withdrawing)}
        title="Withdraw this assignment?"
        description={
          withdrawing
            ? `It disappears for all ${withdrawing.summary.total} student${withdrawing.summary.total === 1 ? '' : 's'}, along with anything already handed in. Work that has been accepted cannot be withdrawn.`
            : ''
        }
        confirmLabel="Withdraw"
        destructive
        onConfirm={async () => {
          const target = withdrawing;
          setWithdrawing(null);
          await withdraw(target);
        }}
        onCancel={() => setWithdrawing(null)}
      />
    </AppShell>
  );
}
