/**
 * UsersPage - List of users to chat with
 *
 * Shows all registered users except yourself.
 *
 * Features:
 * - Online/offline presence, live via Socket.IO
 * - Role badge (student/mentor) so mentors are identifiable at a glance
 * - Row opens the chat; a separate button opens that person's profile
 * - New signups appear without a refresh ('user-added' / 'user-updated')
 *
 * Accessibility note on the row: the whole row used to be a `<div onClick>`,
 * which is invisible to the keyboard. It's now a real `<button>` that fills
 * the row, with the Profile button as its SIBLING rather than a child. That
 * removes the nested-interactive-element problem and the `stopPropagation`
 * it needed, and both controls are now tabbable.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import { RoleBadge, VerifiedBadge } from '../components/Badge';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { InlineLoader } from '../components/Loading';
import { MessagesIcon } from '../components/Icons';
import styles from './UsersPage.module.css';

export default function UsersPage() {
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();

  // List of all users
  const [users, setUsers] = useState([]);

  // Set of online user IDs (for quick lookup)
  const [onlineUserIds, setOnlineUserIds] = useState(new Set());

  // Loading state
  const [loading, setLoading] = useState(true);

  /**
   * Effect: Fetch all users from server
   *
   * We exclude the current user (you can't chat with yourself!)
   */
  useEffect(() => {
    const fetchUsers = async () => {
      if (!dbUser) return;

      try {
        const response = await authFetch(
          `/api/users?exclude=${dbUser.firebaseUid}`
        );

        if (response.ok) {
          const data = await response.json();
          setUsers(data);

          // Initialize online status from fetched data
          const onlineIds = new Set(
            data.filter(u => u.isOnline).map(u => u._id)
          );
          setOnlineUserIds(onlineIds);
        }
      } catch (err) {
        console.error('Error fetching users:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [dbUser, authFetch]);

  /**
   * Effect: Listen for real-time status changes
   *
   * When someone comes online/offline, server broadcasts 'user-status-change'.
   * We update our onlineUserIds set accordingly.
   */
  useEffect(() => {
    if (!socket) return;

    const handleStatusChange = ({ visitorId, isOnline }) => {
      setOnlineUserIds(prev => {
        const newSet = new Set(prev);
        if (isOnline) {
          newSet.add(visitorId);
        } else {
          newSet.delete(visitorId);
        }
        return newSet;
      });
    };

    // When we first connect, server sends list of online users
    const handleOnlineUsers = (userIds) => {
      setOnlineUserIds(new Set(userIds));
    };

    /**
     * A brand-new account just signed up for the first time.
     *
     * The list is otherwise fetched once on mount, so without this a new
     * person stayed invisible until someone manually refreshed.
     *
     * Two guards: skip ourselves (the server broadcasts to everyone,
     * including the user who just registered), and skip anyone already in
     * the list, so a duplicate broadcast can never produce a duplicate row.
     */
    const handleUserAdded = (newUser) => {
      if (!newUser?._id || newUser._id === dbUser?._id) return;
      setUsers(prev => {
        if (prev.some(u => u._id === newUser._id)) return prev;
        // Re-sort rather than append: /api/users returns the list sorted by
        // display name, and appending would put the newcomer out of order
        // until the next reload.
        return [...prev, newUser].sort((a, b) =>
          (a.displayName || '').localeCompare(b.displayName || '')
        );
      });
    };

    /**
     * An existing user changed something the list displays — in practice,
     * their role. New accounts arrive via `user-added` BEFORE they reach the
     * first-login role picker, so their badge only becomes correct here.
     */
    const handleUserUpdated = (updated) => {
      if (!updated?._id) return;
      setUsers(prev =>
        prev.map(u => (u._id === updated._id ? { ...u, ...updated } : u))
      );
    };

    socket.on('user-status-change', handleStatusChange);
    socket.on('online-users', handleOnlineUsers);
    socket.on('user-added', handleUserAdded);
    socket.on('user-updated', handleUserUpdated);

    // Cleanup listeners on unmount
    return () => {
      socket.off('user-status-change', handleStatusChange);
      socket.off('online-users', handleOnlineUsers);
      socket.off('user-added', handleUserAdded);
      socket.off('user-updated', handleUserUpdated);
    };
  }, [socket, dbUser]);

  const onlineCount = users.filter(u => onlineUserIds.has(u._id)).length;

  return (
    <AppShell
      title="Messages"
      subtitle={
        loading
          ? undefined
          : `${users.length} ${users.length === 1 ? 'person' : 'people'}` +
            (onlineCount > 0 ? ` · ${onlineCount} online` : '')
      }
    >
      <Card padded={false}>
        {loading ? (
          <InlineLoader label="Loading people" />
        ) : users.length === 0 ? (
          <EmptyState
            icon={<MessagesIcon size={20} />}
            title="No one else here yet"
            description="Once someone else signs in they'll appear here and you can start a conversation."
          />
        ) : (
          <ul className={styles.list}>
            {users.map(user => {
              const isOnline = onlineUserIds.has(user._id);

              return (
                <li key={user._id} className={styles.row}>
                  <button
                    type="button"
                    onClick={() => navigate(`/chat/${user._id}`)}
                    className={styles.rowMain}
                  >
                    <Avatar
                      src={user.photoURL}
                      name={user.displayName}
                      presence={isOnline}
                    />
                    <span className={styles.rowText}>
                      <span className={styles.rowName}>
                        {user.displayName}
                        <RoleBadge role={user.role} />
                        <VerifiedBadge user={user} />
                      </span>
                      <span className={styles.rowStatus}>
                        {isOnline ? 'Online' : 'Offline'}
                      </span>
                    </span>
                  </button>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(`/users/${user._id}`)}
                    className={styles.profileButton}
                  >
                    Profile
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
