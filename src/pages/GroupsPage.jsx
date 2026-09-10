/**
 * GroupsPage - Create and browse/join group chats
 *
 * Two sections:
 * 1. Browse groups: see all groups; Open the ones you're in, Join the rest
 *    — everyone, students included.
 * 2. Create a group — MENTORS ONLY. Students get an explanatory note
 *    instead of the form, so the absence reads as a rule rather than a
 *    missing feature. The server enforces this independently in
 *    POST /api/groups.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConversations } from '../context/ConversationsContext';
import UnreadBadge from '../components/UnreadBadge';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import { Field, Input } from '../components/Field';
import EmptyState from '../components/EmptyState';
import { InlineLoader } from '../components/Loading';
import { useToast } from '../components/Toast';
import { GroupsIcon } from '../components/Icons';
import { canMentor } from '../lib/roles';
import styles from './GroupsPage.module.css';

export default function GroupsPage() {
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();
  const { byGroup, markGroupRead } = useConversations();
  const toast = useToast();

  // Mentors and admins may create groups. The server enforces this
  // independently in POST /api/groups; hiding the form here is just so
  // students aren't shown a button that would only ever fail.
  const isMentor = canMentor(dbUser?.role);

  // Create-form state
  const [groupName, setGroupName] = useState('');
  const [users, setUsers] = useState([]);              // other users to pick from
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false); // collapse/expand the create form

  // Browse state
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState(null);

  /**
   * Fetch the list of other users (to choose group members from).
   * Same endpoint UsersPage uses.
   */
  useEffect(() => {
    const fetchUsers = async () => {
      if (!dbUser) return;
      try {
        const res = await authFetch(`/api/users?exclude=${dbUser.firebaseUid}`);
        if (res.ok) setUsers(await res.json());
      } catch (err) {
        console.error('Error fetching users:', err);
      }
    };
    fetchUsers();
  }, [dbUser, authFetch]);

  /**
   * Keep the member picker current when someone signs up.
   *
   * Same one-fetch-on-mount staleness the users list had: without this, a new
   * account can't be added to a group until the page is reloaded.
   */
  useEffect(() => {
    if (!socket) return;

    const handleUserAdded = (newUser) => {
      if (!newUser?._id || newUser._id === dbUser?._id) return;
      setUsers((prev) => {
        if (prev.some((u) => u._id === newUser._id)) return prev;
        return [...prev, newUser].sort((a, b) =>
          (a.displayName || '').localeCompare(b.displayName || '')
        );
      });
    };

    socket.on('user-added', handleUserAdded);
    return () => socket.off('user-added', handleUserAdded);
  }, [socket, dbUser]);

  /**
   * Fetch all groups (so we can show Open vs Join per group).
   */
  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const res = await authFetch('/api/groups');
        if (res.ok) setGroups(await res.json());
      } catch (err) {
        console.error('Error fetching groups:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchGroups();
  }, [authFetch]);

  /**
   * Toggle a user in/out of the selected-members set.
   */
  const toggleMember = (userId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  /**
   * Create the group, then jump straight into its chat.
   */
  const handleCreate = async (e) => {
    e.preventDefault();
    if (!groupName.trim() || !dbUser) return;

    setCreating(true);
    try {
      // No createdBy: the server takes the creator from the token.
      const res = await authFetch('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          name: groupName.trim(),
          memberIds: Array.from(selectedIds)
        })
      });

      if (res.ok) {
        const group = await res.json();
        navigate(`/group/${group._id}`);
      } else {
        // Show the server's reason (e.g. the 403 for non-mentors) rather
        // than a generic failure, so the gate is self-explanatory.
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Failed to create group');
      }
    } catch (err) {
      console.error('Error creating group:', err);
      toast.error('Failed to create group');
    } finally {
      setCreating(false);
    }
  };

  /**
   * Join a group I'm not yet a member of, then open it.
   */
  const handleJoin = async (groupId) => {
    if (!dbUser) return;
    setJoiningId(groupId);

    try {
      // No body: you can only ever add yourself, so the server uses
      // the identity on the token.
      const res = await authFetch(`/api/groups/${groupId}/join`, {
        method: 'POST'
      });
      if (res.ok) {
        navigate(`/group/${groupId}`);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Failed to join group');
      }
    } catch (err) {
      console.error('Error joining group:', err);
      toast.error('Failed to join group');
    } finally {
      setJoiningId(null);
    }
  };

  // Is the current user already a member of this group?
  const isMember = (group) =>
    group.members?.some((m) => (m._id || m) === dbUser?._id);


  /**
   * Groups you are talking in, most recent first; everything else after.
   *
   * The same rule the messages list follows, and for the same reason: a group
   * with three unread messages sitting below one you have never joined is a
   * list sorted by nothing anybody cares about.
   */
  const ordered = [...groups].sort((a, b) => {
    const at = byGroup[a._id]?.lastAt;
    const bt = byGroup[b._id]?.lastAt;

    if (at && bt) return new Date(bt) - new Date(at);
    if (at) return -1;
    if (bt) return 1;
    return 0;
  });

  return (
    <AppShell
      title="Groups"
      subtitle={isMentor ? 'Create a group or join an existing one' : 'Join a group to start chatting'}
      actions={
        isMentor && (
          <Button
            variant={createOpen ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => setCreateOpen((open) => !open)}
          >
            {createOpen ? 'Cancel' : 'New group'}
          </Button>
        )
      }
    >
      {/* Create group — mentors only, revealed from the header action */}
      {isMentor && createOpen && (
        <Card title="Create a group">
          <form onSubmit={handleCreate} className={styles.form}>
            <Field label="Group name">
              <Input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. DSA Doubts"
                autoFocus
              />
            </Field>

            <Field
              label="Add members"
              hint={
                selectedIds.size > 0
                  ? `${selectedIds.size} selected — you're included automatically`
                  : "You're included automatically"
              }
            >
              <div className={styles.memberList}>
                {users.length === 0 ? (
                  <p className={styles.muted}>No other users to add yet.</p>
                ) : (
                  users.map((u) => (
                    <label key={u._id} className={styles.memberRow}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(u._id)}
                        onChange={() => toggleMember(u._id)}
                        className={styles.checkbox}
                      />
                      <Avatar src={u.photoURL} name={u.displayName} size="xs" />
                      <span className={styles.memberName}>{u.displayName}</span>
                    </label>
                  ))
                )}
              </div>
            </Field>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={creating}
                disabled={!groupName.trim()}
              >
                {creating ? 'Creating' : 'Create group'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Students: explain the absence rather than just omitting the button */}
      {!isMentor && (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>Only mentors can create groups</p>
          <p className={styles.noticeText}>
            You can join and chat in any group below. If you mentor others, switch
            your role from your profile.
          </p>
        </div>
      )}

      {/* Browse groups */}
      <Card padded={false}>
        {loading ? (
          <InlineLoader label="Loading groups" />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<GroupsIcon size={20} />}
            title="No groups yet"
            description={
              isMentor
                ? 'Create the first one and add the people who should be in it.'
                : 'Once a mentor creates a group it will show up here to join.'
            }
          />
        ) : (
          <ul className={styles.list}>
            {ordered.map((g) => {
              const member = isMember(g);
              const count = g.members?.length || 0;
              const convo = byGroup[g._id];
              const unread = convo?.unread || 0;

              return (
                <li key={g._id} className={styles.row}>
                  <span className={styles.groupAvatar} aria-hidden="true">
                    {g.name?.charAt(0)?.toUpperCase() || 'G'}
                  </span>

                  <span className={styles.rowText}>
                    <span className={styles.groupName}>{g.name}</span>

                    {/* A member who has spoken here gets the last thing said,
                        prefixed with who said it — the one thing a group
                        preview needs that a direct-message preview does not,
                        because "who" is not implied by the row you are on.
                        Non-members get the member count: they have no
                        conversation to preview, and a stranger's messages are
                        not theirs to read. */}
                    {member && convo ? (
                      <span
                        className={[
                          styles.groupPreview,
                          unread > 0 ? styles.groupPreviewUnread : ''
                        ].filter(Boolean).join(' ')}
                      >
                        <span className={styles.who}>
                          {convo.lastFromMe ? 'You' : convo.lastSenderName}:{' '}
                        </span>
                        {convo.lastText}
                      </span>
                    ) : (
                      <span className={styles.groupMeta}>
                        {count} member{count === 1 ? '' : 's'}
                        {member ? ' · You’re in this group' : ''}
                      </span>
                    )}
                  </span>

                  <UnreadBadge count={unread} label="unread messages" />

                  {member ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        markGroupRead(g._id);
                        navigate(`/group/${g._id}`);
                      }}
                    >
                      Open
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={joiningId === g._id}
                      onClick={() => handleJoin(g._id)}
                    >
                      Join
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
