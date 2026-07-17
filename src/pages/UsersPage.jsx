/**
 * UsersPage - List of users to chat with
 * 
 * This page shows all registered users (except yourself).
 * Click on a user to start chatting with them.
 * 
 * Features:
 * - Shows online/offline status (green dot)
 * - Real-time status updates via Socket.IO
 * - Click to navigate to chat
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function UsersPage() {
  const navigate = useNavigate();
  const { dbUser, socket, logout, SERVER_URL } = useAuth();
  
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
        const response = await fetch(
          `${SERVER_URL}/api/users?exclude=${dbUser.firebaseUid}`
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
  }, [dbUser, SERVER_URL]);

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

    socket.on('user-status-change', handleStatusChange);
    socket.on('online-users', handleOnlineUsers);

    // Cleanup listeners on unmount
    return () => {
      socket.off('user-status-change', handleStatusChange);
      socket.off('online-users', handleOnlineUsers);
    };
  }, [socket]);

  /**
   * Navigate to chat with specific user
   */
  const openChat = (peerId) => {
    navigate(`/chat/${peerId}`);
  };

  // Loading state
  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading users...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Messages</h1>
          <p style={styles.subtitle}>
            Logged in as {dbUser?.displayName}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => navigate('/groups')} style={styles.logoutBtn}>
            Groups
          </button>
          <button onClick={logout} style={styles.logoutBtn}>
            Logout
          </button>
        </div>
      </div>

      {/* Users List */}
      <div style={styles.usersList}>
        {users.length === 0 ? (
          <div style={styles.emptyState}>
            <p>No other users yet.</p>
            <p style={styles.emptyHint}>
              Ask a friend to sign in to start chatting!
            </p>
          </div>
        ) : (
          users.map(user => (
            <div
              key={user._id}
              onClick={() => openChat(user._id)}
              style={styles.userCard}
            >
              {/* Avatar */}
              <div style={styles.avatarWrapper}>
                {user.photoURL ? (
                  <img 
                    src={user.photoURL} 
                    alt={user.displayName}
                    style={styles.avatar}
                  />
                ) : (
                  <div style={styles.avatarPlaceholder}>
                    {user.displayName?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                )}
                {/* Online indicator dot */}
                <div 
                  style={{
                    ...styles.statusDot,
                    backgroundColor: onlineUserIds.has(user._id) ? '#22c55e' : '#9ca3af'
                  }}
                />
              </div>

              {/* User info */}
              <div style={styles.userInfo}>
                <span style={styles.userName}>{user.displayName}</span>
                <span style={styles.userStatus}>
                  {onlineUserIds.has(user._id) ? 'Online' : 'Offline'}
                </span>
              </div>

              {/* Arrow */}
              <svg 
                width="20" 
                height="20" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="#9ca3af"
                strokeWidth="2"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Styles object (CSS-in-JS)
// In a real app, you might use CSS Modules, Tailwind, or styled-components
const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#f5f5f5',
    padding: '0'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 24px',
    backgroundColor: '#3b82f6',
    color: '#fff'
  },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: '600'
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: '14px',
    opacity: 0.9
  },
  logoutBtn: {
    padding: '8px 16px',
    backgroundColor: 'rgba(255,255,255,0.2)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  usersList: {
    padding: '16px'
  },
  userCard: {
    display: 'flex',
    alignItems: 'center',
    padding: '16px',
    backgroundColor: '#fff',
    borderRadius: '12px',
    marginBottom: '12px',
    cursor: 'pointer',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease'
  },
  avatarWrapper: {
    position: 'relative',
    marginRight: '16px'
  },
  avatar: {
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    objectFit: 'cover'
  },
  avatarPlaceholder: {
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    backgroundColor: '#3b82f6',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '20px',
    fontWeight: '600'
  },
  statusDot: {
    position: 'absolute',
    bottom: '2px',
    right: '2px',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    border: '2px solid #fff'
  },
  userInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column'
  },
  userName: {
    fontSize: '16px',
    fontWeight: '500',
    color: '#1f2937'
  },
  userStatus: {
    fontSize: '13px',
    color: '#6b7280',
    marginTop: '2px'
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    fontSize: '16px',
    color: '#6b7280'
  },
  emptyState: {
    textAlign: 'center',
    padding: '60px 20px',
    color: '#6b7280'
  },
  emptyHint: {
    marginTop: '8px',
    fontSize: '14px',
    opacity: 0.7
  }
};
