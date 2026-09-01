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
 *
 * The copy now says the choice is changeable, because it is (Profile → Role).
 * A permanent-looking one-time decision makes people hesitate over what is
 * actually a reversible pick.
 */

import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { Spinner } from '../components/Loading';
import styles from './RoleSelectPage.module.css';

const OPTIONS = [
  {
    role: 'student',
    label: 'Student',
    description: 'Find mentors, join groups, and work towards your goals.'
  },
  {
    role: 'mentor',
    label: 'Mentor',
    description: 'Guide students, create groups, and post announcements.'
  }
];

export default function RoleSelectPage() {
  const { dbUser, chooseRole } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(null); // which role is being saved

  const pick = async (role) => {
    if (saving) return;

    setSaving(role);
    const ok = await chooseRole(role);
    // On success App unmounts this page; if it failed, re-enable the buttons.
    setSaving(null);

    if (!ok) toast.error('Could not save your choice. Please try again.');
  };

  const firstName = dbUser?.displayName?.split(' ')[0];

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">M</span>
          <span className={styles.brandName}>MentorConnect</span>
        </div>

        <h1 className={styles.title}>
          Welcome{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className={styles.subtitle}>
          How will you use MentorConnect? This sets what you can do — and you
          can change it later from your profile.
        </p>

        <div className={styles.options}>
          {OPTIONS.map((option) => (
            <button
              key={option.role}
              type="button"
              onClick={() => pick(option.role)}
              disabled={Boolean(saving)}
              className={styles.option}
            >
              <span className={styles.optionHeader}>
                <span className={styles.optionLabel}>{option.label}</span>
                {saving === option.role && <Spinner size="sm" />}
              </span>
              <span className={styles.optionDescription}>{option.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
