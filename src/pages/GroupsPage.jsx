/**
 * GroupsPage - Create and browse/join group chats
 *
 * Two sections:
 * 1. Create a group: pick a name + select members from the user list
 * 2. Browse groups: see all groups; Open the ones you're in, Join the rest
 *
 * Reuses the same REST + Socket.IO backend patterns as UsersPage/ChatPage
 * and the existing #3b82f6 styling.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function GroupsPage() {
  const navigate = useNavigate();
  const { dbUser, logout, SERVER_URL } = useAuth();

  // Create-form state
  const [groupName, setGroupName] = useState('');
  const [users, setUsers] = useState([]);              // other users to pick from
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [creating, setCreating] = useState(false);

  // Browse state
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  /**
   * Fetch the list of other users (to choose group members from).
   * Same endpoint UsersPage uses.
   */
  useEffect(() => {
    const fetchUsers = async () => {
      if (!dbUser) return;
      try {
        const res = await fetch(`${SERVER_URL}/api/users?exclude=${dbUser.firebaseUid}`);
        if (res.ok) setUsers(await res.json());
      } catch (err) {
        console.error('Error fetching users:', err);
      }
    };
    fetchUsers();
  }, [dbUser, SERVER_URL]);

  /**
   * Fetch all groups (so we can show Open vs Join per group).
   */
  const fetchGroups = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/groups`);
      if (res.ok) setGroups(await res.json());
    } catch (err) {
      console.error('Error fetching groups:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SERVER_URL]);

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
      const res = await fetch(`${SERVER_URL}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: groupName.trim(),
          createdBy: dbUser._id,
          memberIds: Array.from(selectedIds)
        })
      });

      if (res.ok) {
        const group = await res.json();
        navigate(`/group/${group._id}`);
      } else {
        alert('Failed to create group');
      }
    } catch (err) {
      console.error('Error creating group:', err);
      alert('Failed to create group');
    } finally {
      setCreating(false);
    }
  };

  /**
   * Join a group I'm not yet a member of, then open it.
   */
  const handleJoin = async (groupId) => {
    if (!dbUser) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/groups/${groupId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: dbUser._id })
      });
      if (res.ok) {
        navigate(`/group/${groupId}`);
      } else {
        alert('Failed to join group');
      }
    } catch (err) {
      console.error('Error joining group:', err);
      alert('Failed to join group');
    }
  };

  // Is the current user already a member of this group?
  const isMember = (group) =>
    group.members?.some((m) => (m._id || m) === dbUser?._id);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Groups</h1>
          <p style={styles.subtitle}>Create a group or join an existing one</p>
        </div>
        <div style={styles.headerActions}>
          <button onClick={() => navigate('/users')} style={styles.navBtn}>
            Messages
          </button>
          <button onClick={logout} style={styles.navBtn}>
            Logout
          </button>
        </div>
      </div>

      <div style={styles.body}>
        {/* Create group */}
        <form onSubmit={handleCreate} style={styles.createCard}>
          <h2 style={styles.sectionTitle}>Create a group</h2>
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name"
            style={styles.input}
          />

          <p style={styles.memberLabel}>Add members</p>
          <div style={styles.memberList}>
            {users.length === 0 ? (
              <p style={styles.emptyHint}>No other users to add yet.</p>
            ) : (
              users.map((u) => (
                <label key={u._id} style={styles.memberRow}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(u._id)}
                    onChange={() => toggleMember(u._id)}
                  />
                  <span style={styles.memberName}>{u.displayName}</span>
                </label>
              ))
            )}
          </div>

          <button
            type="submit"
            style={styles.createBtn}
            disabled={creating || !groupName.trim()}
          >
            {creating ? 'Creating...' : 'Create Group'}
          </button>
        </form>

        {/* Browse groups */}
        <div style={styles.browseCard}>
          <h2 style={styles.sectionTitle}>All groups</h2>
          {loading ? (
            <p style={styles.emptyHint}>Loading groups...</p>
          ) : groups.length === 0 ? (
            <p style={styles.emptyHint}>No groups yet. Create the first one!</p>
          ) : (
            groups.map((g) => (
              <div key={g._id} style={styles.groupRow}>
                <div style={styles.groupAvatar}>
                  {g.name?.charAt(0)?.toUpperCase() || 'G'}
                </div>
                <div style={styles.groupInfo}>
                  <span style={styles.groupName}>{g.name}</span>
                  <span style={styles.groupMeta}>
                    {g.members?.length || 0} member
                    {(g.members?.length || 0) === 1 ? '' : 's'}
                  </span>
                </div>
                {isMember(g) ? (
                  <button
                    onClick={() => navigate(`/group/${g._id}`)}
                    style={styles.openBtn}
                  >
                    Open
                  </button>
                ) : (
                  <button onClick={() => handleJoin(g._id)} style={styles.joinBtn}>
                    Join
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#f5f5f5'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 24px',
    backgroundColor: '#3b82f6',
    color: '#fff'
  },
  title: { margin: 0, fontSize: '24px', fontWeight: '600' },
  subtitle: { margin: '4px 0 0', fontSize: '14px', opacity: 0.9 },
  headerActions: { display: 'flex', gap: '8px' },
  navBtn: {
    padding: '8px 16px',
    backgroundColor: 'rgba(255,255,255,0.2)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '640px',
    margin: '0 auto'
  },
  createCard: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
  },
  browseCard: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
  },
  sectionTitle: {
    margin: '0 0 16px',
    fontSize: '18px',
    fontWeight: '600',
    color: '#1f2937'
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '15px',
    outline: 'none',
    boxSizing: 'border-box'
  },
  memberLabel: {
    margin: '16px 0 8px',
    fontSize: '14px',
    fontWeight: '500',
    color: '#374151'
  },
  memberList: {
    maxHeight: '200px',
    overflowY: 'auto',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '8px'
  },
  memberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px',
    cursor: 'pointer'
  },
  memberName: { fontSize: '15px', color: '#1f2937' },
  createBtn: {
    marginTop: '16px',
    width: '100%',
    padding: '12px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '15px',
    fontWeight: '500',
    cursor: 'pointer'
  },
  groupRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 0',
    borderBottom: '1px solid #f0f0f0'
  },
  groupAvatar: {
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    backgroundColor: '#3b82f6',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px',
    fontWeight: '600',
    marginRight: '12px'
  },
  groupInfo: { flex: 1, display: 'flex', flexDirection: 'column' },
  groupName: { fontSize: '16px', fontWeight: '500', color: '#1f2937' },
  groupMeta: { fontSize: '13px', color: '#6b7280', marginTop: '2px' },
  openBtn: {
    padding: '8px 20px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  joinBtn: {
    padding: '8px 20px',
    backgroundColor: '#fff',
    color: '#3b82f6',
    border: '1px solid #3b82f6',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  emptyHint: { color: '#6b7280', fontSize: '14px', margin: 0 }
};
