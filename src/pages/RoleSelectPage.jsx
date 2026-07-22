/**
 * RoleSelectPage - First-login role picker
 *
 * Shown once, right after a user's first Google sign-in, when their account
 * has no role yet. It blocks the app (App.jsx renders this instead of the
 * routes) until the user chooses "student" or "mentor". After choosing,
 * chooseRole() updates dbUser and App re-renders into the normal routes.
 *
 * Why here? Google sign-in gives us no place to ask for a role, and there is
 * no registration form — so the moment right after the first sign-in is the
 * only natural place to collect it.
 */

import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function RoleSelectPage() {
  const { dbUser, chooseRole } = useAuth();
  const [saving, setSaving] = useState(false);

  const pick = async (role) => {
    setSaving(true);
    await chooseRole(role);
    // On success App unmounts this page; if it failed, re-enable the buttons.
    setSaving(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>
          Welcome{dbUser?.displayName ? `, ${dbUser.displayName}` : ''}!
        </h1>
        <p style={styles.subtitle}>How will you use this platform?</p>

        <div style={styles.options}>
          <button
            onClick={() => pick('student')}
            disabled={saving}
            style={styles.optionBtn}
          >
            <span style={styles.optionEmoji}>🎓</span>
            <span style={styles.optionLabel}>Student</span>
            <span style={styles.optionDesc}>Learn and connect with mentors</span>
          </button>

          <button
            onClick={() => pick('mentor')}
            disabled={saving}
            style={styles.optionBtn}
          >
            <span style={styles.optionEmoji}>🧑‍🏫</span>
            <span style={styles.optionLabel}>Mentor</span>
            <span style={styles.optionDesc}>Guide and support students</span>
          </button>
        </div>

        {saving && <p style={styles.saving}>Saving...</p>}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#3b82f6',
    padding: '16px'
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: '16px',
    padding: '32px',
    width: '100%',
    maxWidth: '480px',
    boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
    textAlign: 'center'
  },
  title: { margin: 0, fontSize: '24px', fontWeight: '600', color: '#1f2937' },
  subtitle: { margin: '8px 0 24px', fontSize: '15px', color: '#6b7280' },
  options: { display: 'flex', gap: '16px' },
  optionBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    padding: '24px 16px',
    backgroundColor: '#f9fafb',
    border: '2px solid #e5e7eb',
    borderRadius: '12px',
    cursor: 'pointer',
    transition: 'border-color 0.15s ease, background-color 0.15s ease'
  },
  optionEmoji: { fontSize: '36px' },
  optionLabel: { fontSize: '18px', fontWeight: '600', color: '#1f2937' },
  optionDesc: { fontSize: '13px', color: '#6b7280' },
  saving: { marginTop: '16px', fontSize: '14px', color: '#6b7280' }
};
