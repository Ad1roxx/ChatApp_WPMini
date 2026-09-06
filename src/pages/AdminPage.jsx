/**
 * AdminPage - Platform overview, verification, moderation and user management
 *
 * Admin-only. Every endpoint behind this page is `requireAuth` +
 * `requireRole('admin')`, and admin cannot be self-assigned — it is granted
 * by the server's ADMIN_EMAILS allowlist. So hiding the nav entry is the
 * usual convenience; the server is what actually refuses.
 *
 * **Every number here is counted live from MongoDB.** None of it is
 * placeholder data. With a three-user database this reads "3", and that is
 * the honest answer.
 *
 * Ordered by what needs a decision: the two queues sit above the user table,
 * because a pending verification or an open report is work waiting on you,
 * while the table is reference.
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
import { InlineLoader } from '../components/Loading';
import EmptyState from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { ShieldIcon } from '../components/Icons';
import { isAdmin } from '../lib/roles';
import styles from './AdminPage.module.css';

const STAT_TILES = [
  { key: 'users', label: 'Users' },
  { key: 'online', label: 'Online now' },
  { key: 'newThisWeek', label: 'New this week' },
  { key: 'groups', label: 'Groups' },
  { key: 'messages', label: 'Direct messages' },
  { key: 'groupMessages', label: 'Group messages' },
  { key: 'announcements', label: 'Announcements' }
];

const REASON_LABELS = {
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate: 'Inappropriate content',
  impersonation: 'Impersonation',
  other: 'Other'
};

export default function AdminPage() {
  const navigate = useNavigate();
  const { dbUser, authFetch } = useAuth();
  const toast = useToast();

  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [verifications, setVerifications] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  // Pending dialogs. Each holds the subject of the decision, or null.
  const [pendingSuspend, setPendingSuspend] = useState(null);
  const [pendingReject, setPendingReject] = useState(null);
  const [pendingReport, setPendingReport] = useState(null);
  const [note, setNote] = useState('');

  const refreshStats = useCallback(async () => {
    const res = await authFetch('/api/admin/stats');
    if (res.ok) setStats(await res.json());
  }, [authFetch]);

  useEffect(() => {
    const load = async () => {
      try {
        // Independent requests, so fire them together
        const [statsRes, usersRes, verifyRes, reportsRes] = await Promise.all([
          authFetch('/api/admin/stats'),
          authFetch('/api/admin/users'),
          authFetch('/api/admin/verifications'),
          authFetch('/api/admin/reports')
        ]);

        if (statsRes.ok) setStats(await statsRes.json());
        if (usersRes.ok) setUsers(await usersRes.json());
        if (verifyRes.ok) setVerifications(await verifyRes.json());
        if (reportsRes.ok) setReports(await reportsRes.json());
      } catch (err) {
        console.error('Error loading admin data:', err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [authFetch]);

  /** Replace one user everywhere they appear on this page. */
  const mergeUser = (updated) => {
    setUsers((prev) => prev.map((u) => (u._id === updated._id ? updated : u)));
    setVerifications((prev) => prev.filter((u) => u._id !== updated._id));
  };

  const setRole = async (userId, role) => {
    setBusyId(userId);
    try {
      const res = await authFetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });

      if (res.ok) {
        const updated = await res.json();
        mergeUser(updated);
        toast.success(`${updated.displayName} is now a ${role}.`);
        await refreshStats();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not change that role');
      }
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Suspend or restore. Suspending asks for a reason first — the person sees
   * it on the screen that replaces the app for them, so "no reason given" is
   * a worse experience than a one-line explanation.
   */
  const applySuspension = async (user, suspended) => {
    setPendingSuspend(null);
    setBusyId(user._id);

    try {
      const res = await authFetch(`/api/admin/users/${user._id}/suspend`, {
        method: 'PATCH',
        body: JSON.stringify({ suspended, reason: note })
      });

      if (res.ok) {
        const updated = await res.json();
        mergeUser(updated);
        toast.success(
          suspended
            ? `${updated.displayName} is suspended.`
            : `${updated.displayName} is active again.`
        );
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not change that account');
      }
    } finally {
      setNote('');
      setBusyId(null);
    }
  };

  const decideVerification = async (user, decision, reviewNote = '') => {
    setPendingReject(null);
    setBusyId(user._id);

    try {
      const res = await authFetch(`/api/admin/verifications/${user._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ decision, note: reviewNote })
      });

      if (res.ok) {
        const updated = await res.json();
        mergeUser(updated);
        toast.success(
          decision === 'approved'
            ? `${updated.displayName} is verified.`
            : `${updated.displayName}'s request was rejected.`
        );
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not record that decision');
      }
    } finally {
      setNote('');
      setBusyId(null);
    }
  };

  const decideReport = async (report, status) => {
    setPendingReport(null);
    setBusyId(report._id);

    try {
      const res = await authFetch(`/api/admin/reports/${report._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note })
      });

      if (res.ok) {
        // It leaves the open queue but is not deleted — it stays readable
        // under ?status=resolved.
        setReports((prev) => prev.filter((r) => r._id !== report._id));
        toast.success(status === 'resolved' ? 'Report resolved' : 'Report dismissed');
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not close that report');
      }
    } finally {
      setNote('');
      setBusyId(null);
    }
  };

  const formatDate = (value) =>
    value
      ? new Date(value).toLocaleDateString([], {
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        })
      : '—';

  // Belt and braces: the route and nav entry are already admin-gated, but a
  // non-admin who types the URL should see a refusal rather than a broken page.
  if (dbUser && !isAdmin(dbUser.role)) {
    return (
      <AppShell title="Admin">
        <Card>
          <EmptyState
            icon={<ShieldIcon size={20} />}
            title="Admins only"
            description="This page is limited to administrators."
            action={
              <Button variant="secondary" onClick={() => navigate('/users')}>
                Back to messages
              </Button>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const pendingCount = verifications.length + reports.length;

  return (
    <AppShell
      title="Admin"
      subtitle={
        loading
          ? 'Platform overview and moderation'
          : pendingCount === 0
            ? 'Nothing waiting on you'
            : `${pendingCount} item${pendingCount === 1 ? '' : 's'} waiting on you`
      }
    >
      {/* ---- Verification queue ---- */}
      <Card
        title="Mentor verification"
        subtitle="Approving means you checked the evidence below"
        padded={false}
      >
        {loading ? (
          <InlineLoader label="Loading queue" />
        ) : verifications.length === 0 ? (
          <EmptyState title="No requests waiting" />
        ) : (
          <ul className={styles.list}>
            {verifications.map((user) => (
              <li key={user._id} className={styles.queueRow}>
                <div className={styles.queueHead}>
                  <Avatar src={user.photoURL} name={user.displayName} size="sm" />
                  <div className={styles.who}>
                    <button
                      type="button"
                      className={styles.name}
                      onClick={() => navigate(`/users/${user._id}`)}
                    >
                      {user.displayName}
                    </button>
                    <span className={styles.email}>{user.email}</span>
                  </div>
                  <Badge variant="warning">Pending</Badge>
                </div>

                <dl className={styles.evidence}>
                  <div>
                    <dt>Title</dt>
                    <dd>{user.verification.title || '—'}</dd>
                  </div>
                  <div>
                    <dt>Company</dt>
                    <dd>{user.verification.company || '—'}</dd>
                  </div>
                  <div>
                    <dt>Experience</dt>
                    <dd>
                      {user.verification.yearsExperience == null
                        ? '—'
                        : `${user.verification.yearsExperience} years`}
                    </dd>
                  </div>
                  <div>
                    <dt>LinkedIn</dt>
                    <dd>
                      {user.verification.linkedinUrl ? (
                        <a
                          href={user.verification.linkedinUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Open profile
                        </a>
                      ) : (
                        'Not provided'
                      )}
                    </dd>
                  </div>
                </dl>

                <p className={styles.caution}>
                  Nothing here has been checked automatically. Approve only what
                  you have looked at yourself.
                </p>

                <div className={styles.queueActions}>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === user._id}
                    onClick={() => {
                      setNote('');
                      setPendingReject(user);
                    }}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === user._id}
                    onClick={() => decideVerification(user, 'approved')}
                  >
                    Approve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- Reports ---- */}
      <Card
        title="Reports"
        subtitle="Closed reports are kept, never deleted"
        padded={false}
      >
        {loading ? (
          <InlineLoader label="Loading reports" />
        ) : reports.length === 0 ? (
          <EmptyState title="No open reports" />
        ) : (
          <ul className={styles.list}>
            {reports.map((report) => (
              <li key={report._id} className={styles.queueRow}>
                <div className={styles.queueHead}>
                  <Avatar
                    src={report.reporter?.photoURL}
                    name={report.reporter?.displayName}
                    size="sm"
                  />
                  <div className={styles.who}>
                    <span className={styles.name}>
                      {report.reporter?.displayName || 'Unknown'} reported a{' '}
                      {report.targetType === 'groupMessage' ? 'group message' : report.targetType}
                    </span>
                    <span className={styles.email}>{formatDate(report.createdAt)}</span>
                  </div>
                  <Badge variant="danger">{REASON_LABELS[report.reason] || report.reason}</Badge>
                </div>

                {/* The snapshot, not the live content — acting on a report
                    usually means deleting what it points at. */}
                <blockquote className={styles.snapshot}>
                  {report.targetSnapshot || 'No content captured'}
                </blockquote>

                {report.details && (
                  <p className={styles.reportDetails}>&ldquo;{report.details}&rdquo;</p>
                )}

                <div className={styles.queueActions}>
                  <Button
                    size="sm"
                    disabled={busyId === report._id}
                    onClick={() => {
                      setNote('');
                      setPendingReport({ report, status: 'dismissed' });
                    }}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === report._id}
                    onClick={() => {
                      setNote('');
                      setPendingReport({ report, status: 'resolved' });
                    }}
                  >
                    Resolve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- Stats ---- */}
      <Card title="At a glance" subtitle="Counted live — no placeholder figures">
        {loading || !stats ? (
          <InlineLoader label="Counting" />
        ) : (
          <div className={styles.stats}>
            {STAT_TILES.map((tile) => (
              <div key={tile.key} className={styles.stat}>
                <span className={styles.statValue}>{stats[tile.key] ?? 0}</span>
                <span className={styles.statLabel}>{tile.label}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---- Users ---- */}
      <Card
        title="Users"
        subtitle="Change a role, suspend an account, or open a profile"
        padded={false}
      >
        {loading ? (
          <InlineLoader label="Loading users" />
        ) : users.length === 0 ? (
          <EmptyState title="No users yet" />
        ) : (
          <ul className={styles.list}>
            {users.map((user) => {
              const self = user._id === dbUser?._id;
              const targetIsAdmin = isAdmin(user.role);
              // The server refuses both of these; the UI just doesn't offer them.
              const locked = self || targetIsAdmin;

              return (
                <li
                  key={user._id}
                  className={[styles.row, user.suspended ? styles.rowSuspended : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <Avatar
                    src={user.photoURL}
                    name={user.displayName}
                    size="sm"
                    presence={user.isOnline}
                  />

                  <div className={styles.who}>
                    <button
                      type="button"
                      className={styles.name}
                      onClick={() => navigate(`/users/${user._id}`)}
                    >
                      {user.displayName}
                    </button>
                    <span className={styles.email}>{user.email}</span>
                  </div>

                  <div className={styles.meta}>
                    <span className={styles.badges}>
                      <RoleBadge role={user.role} />
                      <VerifiedBadge user={user} />
                      {user.suspended && <Badge variant="danger">Suspended</Badge>}
                    </span>
                    <span className={styles.joined}>Joined {formatDate(user.createdAt)}</span>
                  </div>

                  <div className={styles.controls}>
                    {locked ? (
                      <span className={styles.lockedNote}>{self ? 'You' : 'Admin'}</span>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant={user.role === 'student' ? 'primary' : 'secondary'}
                          disabled={busyId === user._id || user.role === 'student'}
                          onClick={() => setRole(user._id, 'student')}
                        >
                          Student
                        </Button>
                        <Button
                          size="sm"
                          variant={user.role === 'mentor' ? 'primary' : 'secondary'}
                          disabled={busyId === user._id || user.role === 'mentor'}
                          onClick={() => setRole(user._id, 'mentor')}
                        >
                          Mentor
                        </Button>
                        <Button
                          size="sm"
                          variant={user.suspended ? 'secondary' : 'danger'}
                          disabled={busyId === user._id}
                          onClick={() => {
                            setNote('');
                            if (user.suspended) applySuspension(user, false);
                            else setPendingSuspend(user);
                          }}
                        >
                          {user.suspended ? 'Restore' : 'Suspend'}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className={styles.footnote}>
        Admin is granted by the server&rsquo;s <code>ADMIN_EMAILS</code> allowlist and
        cannot be assigned from this page — if it could, one compromised admin
        account would be enough to mint more.
      </p>

      {/* ---- Dialogs ---- */}
      <ConfirmDialog
        open={Boolean(pendingSuspend)}
        title={`Suspend ${pendingSuspend?.displayName || ''}?`}
        description="They will be signed out of everything immediately and shown this reason. Their messages and groups are kept."
        confirmLabel="Suspend"
        destructive
        confirmDisabled={!note.trim()}
        onConfirm={() => applySuspension(pendingSuspend, true)}
        onCancel={() => {
          setPendingSuspend(null);
          setNote('');
        }}
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason — shown to the person being suspended"
          maxLength={500}
          rows={3}
          autoFocus
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(pendingReject)}
        title={`Reject ${pendingReject?.displayName || ''}'s request?`}
        description="They can correct the details and submit again, so say what was missing."
        confirmLabel="Reject"
        destructive
        confirmDisabled={!note.trim()}
        onConfirm={() => decideVerification(pendingReject, 'rejected', note)}
        onCancel={() => {
          setPendingReject(null);
          setNote('');
        }}
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. The LinkedIn profile is private, so I could not check it"
          maxLength={500}
          rows={3}
          autoFocus
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(pendingReport)}
        title={pendingReport?.status === 'resolved' ? 'Resolve this report?' : 'Dismiss this report?'}
        description={
          pendingReport?.status === 'resolved'
            ? 'Record what you did about it. The report is kept either way.'
            : 'Record why no action was needed. The report is kept either way.'
        }
        confirmLabel={pendingReport?.status === 'resolved' ? 'Resolve' : 'Dismiss'}
        onConfirm={() => decideReport(pendingReport.report, pendingReport.status)}
        onCancel={() => {
          setPendingReport(null);
          setNote('');
        }}
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for the record"
          maxLength={500}
          rows={3}
          autoFocus
        />
      </ConfirmDialog>
    </AppShell>
  );
}
