/**
 * ProfilePage - View and edit your own profile
 *
 * Everyone can set a bio. Mentors additionally get "area of expertise" and
 * an availability note — those inputs only render when role === 'mentor'
 * (and the server independently refuses to store them for students).
 *
 * Also where you CHANGE your role. It's chosen at first login, and before
 * this the pick was permanent — one mis-tap and the only way out was a new
 * Google account. Now that roles actually gate things (mentors create
 * groups and post announcements), being stuck in the wrong one matters.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import { RoleBadge } from '../components/Badge';
import { Field, Input, Textarea } from '../components/Field';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { PageLoader } from '../components/Loading';
import { canMentor, isAdmin } from '../lib/roles';
import styles from './ProfilePage.module.css';

const ROLES = [
  { value: 'student', label: 'Student', hint: 'Join groups and read announcements' },
  { value: 'mentor', label: 'Mentor', hint: 'Create groups and post announcements' }
];

export default function ProfilePage() {
  const { dbUser, updateProfile, chooseRole } = useAuth();
  const toast = useToast();

  const isMentor = canMentor(dbUser?.role);

  // Form state
  const [bio, setBio] = useState('');
  const [expertise, setExpertise] = useState('');
  const [availability, setAvailability] = useState('');
  const [saving, setSaving] = useState(false);
  const [switchingRole, setSwitchingRole] = useState(false);

  // Which role the confirm dialog is asking about (null = closed)
  const [pendingRole, setPendingRole] = useState(null);

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

  /**
   * Switch between student and mentor.
   *
   * Confirmed first, because this is not a cosmetic label: it changes what
   * you can do (create groups, post announcements) and which profile fields
   * you can fill in. Reuses chooseRole(), which is the same POST the
   * first-login picker makes and keeps dbUser in sync app-wide.
   */
  const confirmRoleSwitch = async () => {
    const newRole = pendingRole;
    setPendingRole(null);
    if (!newRole) return;

    setSwitchingRole(true);
    const ok = await chooseRole(newRole);
    setSwitchingRole(false);

    if (ok) {
      toast.success(`You are now a ${newRole}.`);
    } else {
      toast.error('Could not change your role. Please try again.');
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);

    // Only send mentor fields if we're a mentor
    const fields = isMentor ? { bio, expertise, availability } : { bio };
    const ok = await updateProfile(fields);
    setSaving(false);

    if (ok) {
      toast.success('Profile saved');
    } else {
      toast.error('Could not save your profile. Please try again.');
    }
  };

  if (!dbUser) {
    return <PageLoader label="Loading your profile" />;
  }

  return (
    <AppShell title="Profile" subtitle="How you appear to everyone else">
      {/* Identity — read-only, comes from Google */}
      <Card>
        <div className={styles.identity}>
          <Avatar src={dbUser.photoURL} name={dbUser.displayName} size="xl" />
          <div className={styles.identityText}>
            <h2 className={styles.name}>{dbUser.displayName}</h2>
            <p className={styles.email}>{dbUser.email}</p>
            <RoleBadge role={dbUser.role} />
          </div>
        </div>
        <p className={styles.identityNote}>
          Your name, photo and email come from your Google account and are
          refreshed each time you sign in.
        </p>
      </Card>

      {/*
        Role. Admins don't get the switcher: admin isn't one of the two
        selectable roles, so every button here would demote them — and the
        server would accept it, since it's a legitimate self-service change.
        The allowlist would restore it at the next sign-in, but silently
        losing the dashboard mid-session is not a good surprise.
      */}
      {isAdmin(dbUser.role) ? (
        <Card title="Role">
          <p className={styles.adminNote}>
            You are an administrator. This role is granted by the server&rsquo;s
            allowlist rather than chosen, so it can&rsquo;t be changed from here.
            Admins can do everything a mentor can, plus manage other people&rsquo;s
            roles from the dashboard.
          </p>
        </Card>
      ) : (
      <Card title="Role" subtitle="Changes what you can do in the app">
        <div className={styles.roles}>
          {ROLES.map((option) => {
            const selected = dbUser.role === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => !selected && setPendingRole(option.value)}
                disabled={switchingRole || selected}
                aria-pressed={selected}
                className={[styles.role, selected ? styles.roleSelected : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className={styles.roleLabel}>
                  {option.label}
                  {selected && <span className={styles.roleCheck} aria-hidden="true">✓</span>}
                </span>
                <span className={styles.roleHint}>{option.hint}</span>
              </button>
            );
          })}
        </div>
      </Card>
      )}

      {/* Editable profile */}
      <Card
        title={isMentor ? 'Mentor details' : 'About you'}
        subtitle={
          isMentor
            ? 'Students see this before they reach out'
            : 'Shown on your public profile'
        }
      >
        <form onSubmit={handleSave} className={styles.form}>
          <Field label="Bio" count={bio.length} max={500}>
            <Textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short introduction — what you're working on, what you care about."
              maxLength={500}
              rows={4}
            />
          </Field>

          {/* Mentor-only. The server independently drops these for students. */}
          {isMentor && (
            <>
              <Field
                label="Area of expertise"
                hint="Comma-separated works well"
                count={expertise.length}
                max={200}
              >
                <Input
                  type="text"
                  value={expertise}
                  onChange={(e) => setExpertise(e.target.value)}
                  placeholder="e.g. Data Structures, DBMS, Web Development"
                  maxLength={200}
                />
              </Field>

              <Field label="Availability" count={availability.length} max={200}>
                <Input
                  type="text"
                  value={availability}
                  onChange={(e) => setAvailability(e.target.value)}
                  placeholder="e.g. Weekday evenings, 6–9pm"
                  maxLength={200}
                />
              </Field>
            </>
          )}

          <div className={styles.formActions}>
            <Button type="submit" variant="primary" loading={saving}>
              {saving ? 'Saving' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={Boolean(pendingRole)}
        title={pendingRole === 'mentor' ? 'Switch to Mentor?' : 'Switch to Student?'}
        description={
          pendingRole === 'mentor'
            ? 'You will be able to create groups and post announcements, and you can fill in your expertise and availability.'
            : 'You will no longer be able to create groups or post announcements. Anything you already created stays where it is.'
        }
        confirmLabel="Switch role"
        onConfirm={confirmRoleSwitch}
        onCancel={() => setPendingRole(null)}
      />
    </AppShell>
  );
}
