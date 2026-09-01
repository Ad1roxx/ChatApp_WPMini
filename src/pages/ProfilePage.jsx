/**
 * ProfilePage - View and edit your own profile
 *
 * Everyone can set a bio. Mentors additionally get "area of expertise" and
 * an availability note — those inputs only render when role === 'mentor'
 * (and the server independently refuses to store them for students).
 *
 * Reuses the same patterns as GroupsPage/UsersPage: useAuth() for data,
 * inline style objects, #3b82f6 header.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProfilePage() {
  const navigate = useNavigate();
  const { dbUser, updateProfile } = useAuth();

  const isMentor = dbUser?.role === 'mentor';

  // Form state
  const [bio, setBio] = useState('');
  const [expertise, setExpertise] = useState('');
  const [availability, setAvailability] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);   // 'success' | 'error' | null

  /**
   * Seed the form from dbUser. Runs again after a save (dbUser is replaced
   * with the server's response), which simply re-confirms the saved values.
   */
  useEffect(() => {
    if (!dbUser) return;
    setBio(dbUser.bio || '');
    setExpertise(dbUser.expertise || '');
    setAvailability(dbUser.availability || '');
  }, [dbUser]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);

    // Only send mentor fields if we're a mentor
    const fields = isMentor ? { bio, expertise, availability } : { bio };
    const ok = await updateProfile(fields);

    setStatus(ok ? 'success' : 'error');
    setSaving(false);
  };

  if (!dbUser) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading profile...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button onClick={() => navigate('/users')} style={styles.backBtn}>
          ← Back
        </button>
        <h1 style={styles.title}>My Profile</h1>
      </div>

      <div style={styles.body}>
        {/* Identity card (read-only — comes from Google) */}
        <div style={styles.card}>
          <div style={styles.identityRow}>
            {dbUser.photoURL ? (
              <img src={dbUser.photoURL} alt="" style={styles.avatar} />
            ) : (
              <div style={styles.avatarPlaceholder}>
                {dbUser.displayName?.charAt(0)?.toUpperCase() || '?'}
              </div>
            )}
            <div style={styles.identityInfo}>
              <span style={styles.name}>{dbUser.displayName}</span>
              <span style={styles.email}>{dbUser.email}</span>
              <span style={styles.roleBadge}>
                {isMentor ? '🧑‍🏫 Mentor' : '🎓 Student'}
              </span>
            </div>
          </div>
          <p style={styles.identityNote}>
            Name, photo and email come from your Google account.
          </p>
        </div>

        {/* Editable profile */}
        <form onSubmit={handleSave} style={styles.card}>
          <h2 style={styles.sectionTitle}>
            {isMentor ? 'Mentor details' : 'About you'}
          </h2>

          <label style={styles.label} htmlFor="bio">Bio</label>
          <textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell people a bit about yourself..."
            rows={4}
            maxLength={500}
            style={styles.textarea}
          />
          <span style={styles.counter}>{bio.length}/500</span>

          {/* Mentor-only fields */}
          {isMentor && (
            <>
              <label style={styles.label} htmlFor="expertise">
                Area of expertise
              </label>
              <input
                id="expertise"
                type="text"
                value={expertise}
                onChange={(e) => setExpertise(e.target.value)}
                placeholder="e.g. Data Structures, DBMS, Web Development"
                maxLength={200}
                style={styles.input}
              />

              <label style={styles.label} htmlFor="availability">
                Availability
              </label>
              <input
                id="availability"
                type="text"
                value={availability}
                onChange={(e) => setAvailability(e.target.value)}
                placeholder="e.g. Weekday evenings, 6-9pm"
                maxLength={200}
                style={styles.input}
              />
            </>
          )}

          <button type="submit" style={styles.saveBtn} disabled={saving}>
            {saving ? 'Saving...' : 'Save Profile'}
          </button>

          {status === 'success' && (
            <p style={styles.success}>✓ Profile saved</p>
          )}
          {status === 'error' && (
            <p style={styles.error}>Could not save. Please try again.</p>
          )}
        </form>
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
  identityNote: { margin: '12px 0 0', fontSize: '12px', color: '#9ca3af' },
  sectionTitle: {
    margin: '0 0 16px',
    fontSize: '18px',
    fontWeight: '600',
    color: '#1f2937'
  },
  label: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#374151',
    marginBottom: '6px'
  },
  input: {
    padding: '12px 14px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '15px',
    outline: 'none',
    marginBottom: '16px',
    fontFamily: 'inherit'
  },
  textarea: {
    padding: '12px 14px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '15px',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit'
  },
  counter: {
    alignSelf: 'flex-end',
    fontSize: '12px',
    color: '#9ca3af',
    margin: '4px 0 16px'
  },
  saveBtn: {
    padding: '12px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '15px',
    fontWeight: '500',
    cursor: 'pointer'
  },
  success: { margin: '12px 0 0', color: '#16a34a', fontSize: '14px', textAlign: 'center' },
  error: { margin: '12px 0 0', color: '#dc2626', fontSize: '14px', textAlign: 'center' },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    fontSize: '16px',
    color: '#6b7280'
  }
};
