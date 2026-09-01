/**
 * AdminPage - Platform overview and user management
 *
 * Admin-only. Both endpoints behind this page are `requireAuth` +
 * `requireRole('admin')`, and admin cannot be self-assigned — it is granted
 * by the server's ADMIN_EMAILS allowlist. So hiding the nav entry is the
 * usual convenience; the server is what actually refuses.
 *
 * **Every number here is counted live from MongoDB.** None of it is
 * placeholder data. A dashboard showing invented figures looks impressive in
 * a screenshot and falls apart the first time someone asks what it means.
 * With a three-user database this reads "3", and that is the honest answer.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import { RoleBadge } from '../components/Badge';
import { InlineLoader } from '../components/Loading';
import EmptyState from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { ShieldIcon } from '../components/Icons';
import { isAdmin } from '../lib/roles';
import styles from './AdminPage.module.css';

/** Which stats to show, in order, and where each comes from. */
const STAT_TILES = [
  { key: 'users', label: 'Users' },
  { key: 'online', label: 'Online now' },
  { key: 'newThisWeek', label: 'New this week' },
  { key: 'groups', label: 'Groups' },
  { key: 'messages', label: 'Direct messages' },
  { key: 'groupMessages', label: 'Group messages' },
  { key: 'announcements', label: 'Announcements' }
];

export default function AdminPage() {
  const navigate = useNavigate();
  const { dbUser, authFetch } = useAuth();
  const toast = useToast();

  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);

  /** Re-read just the counts, after something changes them. */
  const refreshStats = useCallback(async () => {
    const res = await authFetch('/api/admin/stats');
    if (res.ok) setStats(await res.json());
  }, [authFetch]);

  useEffect(() => {
    const load = async () => {
      try {
        // Independent requests, so fire them together
        const [statsRes, usersRes] = await Promise.all([
          authFetch('/api/admin/stats'),
          authFetch('/api/admin/users')
        ]);

        if (statsRes.ok) setStats(await statsRes.json());
        if (usersRes.ok) setUsers(await usersRes.json());
      } catch (err) {
        console.error('Error loading admin data:', err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [authFetch]);

  /**
   * Change someone else's role.
   *
   * The server refuses to set 'admin' here (only the allowlist grants it),
   * refuses to touch another admin, and refuses to change your own role —
   * which would let you demote yourself out of this page.
   */
  const setRole = async (userId, role) => {
    setSavingId(userId);

    try {
      const res = await authFetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });

      if (res.ok) {
        const updated = await res.json();
        setUsers((prev) => prev.map((u) => (u._id === updated._id ? updated : u)));
        toast.success(`${updated.displayName} is now a ${role}.`);

        // Role counts moved, so the tiles are stale
        await refreshStats();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not change that role');
      }
    } catch (err) {
      console.error('Error changing role:', err);
      toast.error('Could not change that role');
    } finally {
      setSavingId(null);
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

  return (
    <AppShell title="Admin" subtitle="Platform overview and user management">
      {/* Stats */}
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

      {/* Role split */}
      {stats && (
        <Card title="Roles">
          <div className={styles.roleSplit}>
            <div className={styles.roleRow}>
              <RoleBadge role="student" />
              <span className={styles.roleCount}>{stats.students}</span>
            </div>
            <div className={styles.roleRow}>
              <RoleBadge role="mentor" />
              <span className={styles.roleCount}>{stats.mentors}</span>
            </div>
            <div className={styles.roleRow}>
              <RoleBadge role="admin" />
              <span className={styles.roleCount}>{stats.admins}</span>
            </div>
            {stats.unassigned > 0 && (
              <div className={styles.roleRow}>
                <span className={styles.unassigned}>Not yet chosen</span>
                <span className={styles.roleCount}>{stats.unassigned}</span>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* User management */}
      <Card
        title="Users"
        subtitle="Change a role, or open someone's profile"
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
                <li key={user._id} className={styles.row}>
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
                    <RoleBadge role={user.role} />
                    <span className={styles.joined}>
                      Joined {formatDate(user.createdAt)}
                    </span>
                  </div>

                  <div className={styles.controls}>
                    {locked ? (
                      <span className={styles.lockedNote}>
                        {self ? 'You' : 'Admin'}
                      </span>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant={user.role === 'student' ? 'primary' : 'secondary'}
                          disabled={savingId === user._id || user.role === 'student'}
                          onClick={() => setRole(user._id, 'student')}
                        >
                          Student
                        </Button>
                        <Button
                          size="sm"
                          variant={user.role === 'mentor' ? 'primary' : 'secondary'}
                          disabled={savingId === user._id || user.role === 'mentor'}
                          onClick={() => setRole(user._id, 'mentor')}
                        >
                          Mentor
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
    </AppShell>
  );
}
