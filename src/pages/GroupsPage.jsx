/**
 * GroupsPage - Your group chats: create one, open one, leave one. Groups are private.
 *
 * Two sections:
 * 1. Your groups: the ones you are a member of (an admin sees every group).
 *    Nobody joins a group; a member can leave one.
 * 2. Create a group — MENTORS ONLY. Students get an explanatory note
 *    instead of the form, so the absence reads as a rule rather than a
 *    missing feature. The server enforces this independently in
 *    POST /api/groups.
 */

import { useState, useEffect, useCallback } from 'react';
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
import { canMentor, isAdmin } from '../lib/roles';
import { addablePeople, isGroupMember } from '../lib/groups';
import ConfirmDialog from '../components/ConfirmDialog';
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
  // Groups are private: nobody joins one. A member can leave; this is the group
  // they have asked to leave, until they confirm.
  const [leaving, setLeaving] = useState(null);
  // The caller's mentorships: a mentor can add only their own active mentees.
  const [mentorships, setMentorships] = useState([]);

  /**
   * Fetch the list of other users (to choose group members from).
   * Same endpoint UsersPage uses.
   */
  useEffect(() => {
    const fetchUsers = async () => {
      if (!dbUser) return;
      try {
        const res = await authFetch(`/api/users?exclude=me`);
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
        // Your own groups; for an admin, every group.
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

  // The same list again, when the server says it has changed.
  const refetchGroups = useCallback(async () => {
    try {
      const res = await authFetch('/api/groups');
      if (res.ok) setGroups(await res.json());
    } catch (err) {
      console.error('Error fetching groups:', err);
    }
  }, [authFetch]);

  // Being added to a group, or taken out of one, changes this list.
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('group-added', refetchGroups);
    socket.on('group-removed', refetchGroups);
    return () => {
      socket.off('group-added', refetchGroups);
      socket.off('group-removed', refetchGroups);
    };
  }, [socket, refetchGroups]);

  useEffect(() => {
    if (!dbUser || !isMentor) return;
    authFetch('/api/mentorships?status=active')
      .then((res) => (res.ok ? res.json() : []))
      .then(setMentorships)
      .catch(() => {});
  }, [dbUser, isMentor, authFetch]);

  // Who can be offered when making a group: the server refuses anyone else.
  const addable = addablePeople(dbUser, users, mentorships);

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
  const handleLeave = async () => {
    const group = leaving;
    setLeaving(null);
    if (!group) return;
    try {
      const res = await authFetch(`/api/groups/${group._id}/leave`, { method: 'POST' });
      if (res.ok) {
        setGroups((prev) => prev.filter((g) => g._id !== group._id));
        toast.success(`You left ${group.name}`);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not leave the group');
      }
    } catch (err) {
      console.error('Error leaving group:', err);
      toast.error('Could not leave the group');
    }
  };

  const isMember = (group) => isGroupMember(group, dbUser?._id);


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
      subtitle={
        isAdmin(dbUser?.role)
          ? 'Every group. Groups are private: only their members and admins see them'
          : isMentor
            ? 'Your groups. Create one and add your mentees'
            : 'The groups you have been added to'
      }
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
                {addable.length === 0 ? (
                  <p className={styles.muted}>
                    {isAdmin(dbUser?.role)
                      ? 'No other users to add yet.'
                      : 'You can add your own mentees. You have no active mentees yet.'}
                  </p>
                ) : (
                  addable.map((u) => (
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
            Groups are private: a mentor adds you to theirs, and the ones you are
            in are listed below. If you mentor others, switch your role from your
            profile.
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
                : 'When a mentor adds you to a group it will show up here.'
            }
          />
        ) : (
          <ul className={styles.list}>
            {ordered.map((g) => {
              const member = isMember(g);
              const count = g.members?.length || 0;
              const convo = byGroup[g._id];
              const unread = convo?.unread || 0;

              /* The row's content, so the member and non-member versions
                 below can wrap the same thing in different containers. */
              const rowContent = (
                <>
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
                </>
              );

              return (
                <li key={g._id} className={styles.row}>
                  {/* The whole bar is the way in, as in the Messages list.
                      Groups are private, so everyone who sees a row is a member
                      of it or an admin; nobody joins a group from here. A member
                      can leave, which is asked about first. */}
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => {
                      if (member) markGroupRead(g._id);
                      navigate(`/group/${g._id}`);
                    }}
                  >
                    {rowContent}
                  </button>
                  {member && (
                    <Button size="sm" variant="secondary" onClick={() => setLeaving(g)}>
                      Leave
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(leaving)}
        title={`Leave ${leaving?.name || 'this group'}?`}
        description="You will stop seeing this group and its messages. Only the person who made it, or an admin, can add you back."
        confirmLabel="Leave"
        destructive
        onConfirm={handleLeave}
        onCancel={() => setLeaving(null)}
      />
    </AppShell>
  );
}
