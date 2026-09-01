/**
 * UserProfilePage - View SOMEONE ELSE'S profile (read-only)
 *
 * The counterpart to ProfilePage: same information, no form. This is what
 * makes mentor profiles worth filling in — before this page, expertise and
 * availability were write-only, since nobody could read them.
 *
 * Reached from the users list ("Profile" button on each card) at
 * /users/:userId. The data comes from GET /api/user/:id, which already
 * returns the whole document including bio/expertise/availability.
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function UserProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { dbUser, socket, SERVER_URL } = useAuth();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Viewing your own id via a direct URL is legal — we just offer "Edit"
  // instead of "Message", since messaging yourself is not a thing.
  const isSelf = dbUser?._id === userId;

  /**
   * Effect: fetch the profile whenever the id in the URL changes.
   */
  useEffect(() => {
    const fetchProfile = async () => {
      setLoading(true);
      setNotFound(false);

      try {
        const response = await fetch(`${SERVER_URL}/api/user/${userId}`);

        if (response.ok) {
          setProfile(await response.json());
        } else {
          // 404 (no such user) and 500 (bad id shape) both land here; from
          // the reader's point of view they are the same thing.
          setNotFound(true);
        }
      } catch (err) {
        console.error('Error fetching profile:', err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [userId, SERVER_URL]);

  /**
   * Effect: keep the online dot honest.
   *
   * The fetch above gives us isOnline at one moment in time. Without this,
   * a profile left open would show a stale status forever. Same
   * 'user-status-change' broadcast the users list already listens to.
   */
  useEffect(() => {
    if (!socket) return;

    const handleStatusChange = ({ visitorId, isOnline }) => {
      if (visitorId !== userId) return;
      setProfile(prev => (prev ? { ...prev, isOnline } : prev));
    };

    socket.on('user-status-change', handleStatusChange);
    return () => socket.off('user-status-change', handleStatusChange);
  }, [socket, userId]);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading profile...</div>
      </div>
    );
  }

  if (notFound || !profile) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <button onClick={() => navigate('/users')} style={styles.backBtn}>
            ← Back
          </button>
          <h1 style={styles.title}>Profile</h1>
        </div>
        <div style={styles.body}>
          <div style={styles.card}>
            <p style={styles.emptyMsg}>This user could not be found.</p>
          </div>
        </div>
      </div>
    );
  }

  const isMentor = profile.role === 'mentor';

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button onClick={() => navigate('/users')} style={styles.backBtn}>
          ← Back
        </button>
        <h1 style={styles.title}>Profile</h1>
      </div>

      <div style={styles.body}>
        {/* Identity card */}
        <div style={styles.card}>
          <div style={styles.identityRow}>
            <div style={styles.avatarWrapper}>
              {profile.photoURL ? (
                <img src={profile.photoURL} alt="" style={styles.avatar} />
              ) : (
                <div style={styles.avatarPlaceholder}>
                  {profile.displayName?.charAt(0)?.toUpperCase() || '?'}
                </div>
              )}
              <div
                style={{
                  ...styles.statusDot,
                  backgroundColor: profile.isOnline ? '#22c55e' : '#9ca3af'
                }}
              />
            </div>
            <div style={styles.identityInfo}>
              <span style={styles.name}>{profile.displayName}</span>
              <span style={styles.email}>{profile.email}</span>
              <span style={styles.roleBadge}>
                {isMentor ? '🧑‍🏫 Mentor' : '🎓 Student'}
              </span>
            </div>
          </div>

          {isSelf ? (
            <button onClick={() => navigate('/profile')} style={styles.actionBtn}>
              Edit my profile
            </button>
          ) : (
            <button
              onClick={() => navigate(`/chat/${profile._id}`)}
              style={styles.actionBtn}
            >
              Message {profile.displayName?.split(' ')[0] || 'user'}
            </button>
          )}
        </div>

        {/* About */}
        <div style={styles.card}>
          <h2 style={styles.sectionTitle}>About</h2>
          {profile.bio ? (
            <p style={styles.bodyText}>{profile.bio}</p>
          ) : (
            <p style={styles.emptyMsg}>
              {isSelf
                ? "You haven't written a bio yet."
                : "This user hasn't written a bio yet."}
            </p>
          )}
        </div>

        {/*
          Mentor-only section. Mirrors ProfilePage: students never had these
          fields to fill in, so rendering an empty "Expertise" card for them
          would just be noise.
        */}
        {isMentor && (
          <div style={styles.card}>
            <h2 style={styles.sectionTitle}>Mentoring</h2>

            <span style={styles.fieldLabel}>Area of expertise</span>
            {profile.expertise ? (
              <p style={styles.bodyText}>{profile.expertise}</p>
            ) : (
              <p style={styles.emptyMsg}>Not specified yet.</p>
            )}

            <span style={{ ...styles.fieldLabel, marginTop: '16px' }}>
              Availability
            </span>
            {profile.availability ? (
              <p style={styles.bodyText}>{profile.availability}</p>
            ) : (
              <p style={styles.emptyMsg}>Not specified yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', backgroundColor: '#f5f5f5' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '16px 24px',
    backgroundColor: '#3b82f6',
    color: '#fff'
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#fff',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '8px'
  },
  title: { margin: 0, fontSize: '22px', fontWeight: '600' },
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '640px',
    margin: '0 auto'
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    display: 'flex',
    flexDirection: 'column'
  },
  identityRow: { display: 'flex', alignItems: 'center', gap: '16px' },
  avatarWrapper: { position: 'relative' },
  avatar: { width: '64px', height: '64px', borderRadius: '50%', objectFit: 'cover' },
  avatarPlaceholder: {
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    backgroundColor: '#3b82f6',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '26px',
    fontWeight: '600'
  },
  statusDot: {
    position: 'absolute',
    bottom: '2px',
    right: '2px',
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    border: '2px solid #fff'
  },
  identityInfo: { display: 'flex', flexDirection: 'column', gap: '2px' },
  name: { fontSize: '18px', fontWeight: '600', color: '#1f2937' },
  email: { fontSize: '14px', color: '#6b7280' },
  roleBadge: {
    marginTop: '6px',
    alignSelf: 'flex-start',
    padding: '3px 10px',
    backgroundColor: '#eef2ff',
    color: '#3b82f6',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: '500'
  },
  actionBtn: {
    marginTop: '20px',
    padding: '12px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '15px',
    fontWeight: '500',
    cursor: 'pointer'
  },
  sectionTitle: {
    margin: '0 0 12px',
    fontSize: '18px',
    fontWeight: '600',
    color: '#1f2937'
  },
  fieldLabel: {
    fontSize: '13px',
    fontWeight: '500',
    color: '#6b7280',
    marginBottom: '4px'
  },
  bodyText: {
    margin: 0,
    fontSize: '15px',
    color: '#1f2937',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap'   // keep the line breaks people typed into the bio
  },
  emptyMsg: { margin: 0, fontSize: '15px', color: '#9ca3af', fontStyle: 'italic' },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    fontSize: '16px',
    color: '#6b7280'
  }
};
