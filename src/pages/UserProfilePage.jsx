/**
 * UserProfilePage - View SOMEONE ELSE'S profile (read-only)
 *
 * The counterpart to ProfilePage: same information, no form. This is what
 * makes mentor profiles worth filling in — before this page, expertise and
 * availability were write-only, since nobody could read them.
 *
 * Reached from the users list ("Profile" button on each row) and from the
 * chat header, at /users/:userId. The data comes from GET /api/user/:id,
 * which already returns the whole document including bio/expertise/
 * availability.
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import { RoleBadge } from '../components/Badge';
import EmptyState from '../components/EmptyState';
import { PageLoader } from '../components/Loading';
import { ProfileIcon } from '../components/Icons';
import styles from './UserProfilePage.module.css';

export default function UserProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();

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
        const response = await authFetch(`/api/user/${userId}`);

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
  }, [userId, authFetch]);

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
    return <PageLoader label="Loading profile" />;
  }

  if (notFound || !profile) {
    return (
      <AppShell title="Profile" backTo="/users">
        <Card>
          <EmptyState
            icon={<ProfileIcon size={20} />}
            title="This user could not be found"
            description="The link may be wrong, or the account may no longer exist."
            action={
              <Button variant="secondary" onClick={() => navigate('/users')}>
                Back to messages
              </Button>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const isMentor = profile.role === 'mentor';
  const firstName = profile.displayName?.split(' ')[0] || 'user';

  return (
    <AppShell title={profile.displayName || 'Profile'} backTo="/users">
      {/* Identity */}
      <Card>
        <div className={styles.identity}>
          <Avatar
            src={profile.photoURL}
            name={profile.displayName}
            size="xl"
            presence={profile.isOnline}
          />
          <div className={styles.identityText}>
            <h2 className={styles.name}>{profile.displayName}</h2>
            <p className={styles.email}>{profile.email}</p>
            <div className={styles.badges}>
              <RoleBadge role={profile.role} />
              <span className={styles.status}>
                {profile.isOnline ? 'Online now' : 'Offline'}
              </span>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          {isSelf ? (
            <Button variant="primary" onClick={() => navigate('/profile')}>
              Edit my profile
            </Button>
          ) : (
            <Button variant="primary" onClick={() => navigate(`/chat/${profile._id}`)}>
              Message {firstName}
            </Button>
          )}
        </div>
      </Card>

      {/* About */}
      <Card title="About">
        {profile.bio ? (
          <p className={styles.prose}>{profile.bio}</p>
        ) : (
          <p className={styles.muted}>
            {isSelf
              ? "You haven't written a bio yet."
              : "This user hasn't written a bio yet."}
          </p>
        )}
      </Card>

      {/*
        Mentor-only section. Mirrors ProfilePage: students never had these
        fields to fill in, so rendering an empty "Expertise" card for them
        would just be noise.
      */}
      {isMentor && (
        <Card title="Mentoring">
          <dl className={styles.details}>
            <div className={styles.detail}>
              <dt className={styles.detailLabel}>Area of expertise</dt>
              <dd className={profile.expertise ? styles.prose : styles.muted}>
                {profile.expertise || 'Not specified yet.'}
              </dd>
            </div>

            <div className={styles.detail}>
              <dt className={styles.detailLabel}>Availability</dt>
              <dd className={profile.availability ? styles.prose : styles.muted}>
                {profile.availability || 'Not specified yet.'}
              </dd>
            </div>
          </dl>
        </Card>
      )}
    </AppShell>
  );
}
