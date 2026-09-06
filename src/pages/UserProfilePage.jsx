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
import { RoleBadge, VerifiedBadge } from '../components/Badge';
import EmptyState from '../components/EmptyState';
import { PageLoader } from '../components/Loading';
import { ProfileIcon } from '../components/Icons';
import { Field, Input, Textarea } from '../components/Field';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { canMentor } from '../lib/roles';
import styles from './UserProfilePage.module.css';

export default function UserProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();

  const [profile, setProfile] = useState(null);

  // Mentorship request dialog
  const [requestOpen, setRequestOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const [requestMessage, setRequestMessage] = useState('');
  const [requesting, setRequesting] = useState(false);

  // Report dialog
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [reporting, setReporting] = useState(false);
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

  /**
   * File a report about this person.
   *
   * The server snapshots what it is about, refuses self-reports, and refuses
   * a second OPEN report from the same person about the same target — so a
   * repeated click gets a clear 409 rather than burying the admin queue.
   */
  const submitReport = async () => {
    setReporting(true);

    try {
      const res = await authFetch('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          targetType: 'user',
          targetId: profile._id,
          reason: reportReason,
          details: reportDetails
        })
      });

      if (res.ok) {
        toast.success('Reported. An administrator will review it.');
        setReportOpen(false);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not file that report');
      }
    } catch (err) {
      console.error('Error filing report:', err);
      toast.error('Could not reach the server');
    } finally {
      setReporting(false);
    }
  };

  /**
   * Ask this person to mentor you.
   *
   * The server decides everything that matters: that they can actually
   * mentor, that they are not suspended, that you are not asking yourself,
   * and that you have no live request with them already. The button is only
   * hidden for the cases the UI can see cheaply.
   */
  const requestMentorship = async () => {
    setRequesting(true);

    try {
      const res = await authFetch('/api/mentorships', {
        method: 'POST',
        body: JSON.stringify({
          mentorId: profile._id,
          topic,
          message: requestMessage
        })
      });

      if (res.ok) {
        toast.success(`Request sent to ${profile.displayName}.`);
        setRequestOpen(false);
        setTopic('');
        setRequestMessage('');
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Could not send that request');
      }
    } catch (err) {
      console.error('Error requesting mentorship:', err);
      toast.error('Could not reach the server');
    } finally {
      setRequesting(false);
    }
  };

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

  const isMentor = canMentor(profile.role);
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
              <VerifiedBadge user={profile} />
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
            <>
              <Button variant="primary" onClick={() => navigate(`/chat/${profile._id}`)}>
                Message {firstName}
              </Button>
              {/* Only offered for people who can actually mentor. The server
                  refuses the rest, so this is convenience, not the rule. */}
              {isMentor && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTopic('');
                    setRequestMessage('');
                    setRequestOpen(true);
                  }}
                >
                  Request mentorship
                </Button>
              )}
              {/* Quiet by design. Reporting should be available without being
                  the second thing you notice about a person. */}
              <Button
                variant="ghost"
                onClick={() => {
                  setReportReason('harassment');
                  setReportDetails('');
                  setReportOpen(true);
                }}
              >
                Report
              </Button>
            </>
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
      <ConfirmDialog
        open={reportOpen}
        title={`Report ${profile.displayName}?`}
        description="An administrator will see this along with a copy of the profile. Reports are kept whether or not action is taken."
        confirmLabel={reporting ? 'Sending…' : 'Send report'}
        destructive
        confirmDisabled={reporting}
        onConfirm={submitReport}
        onCancel={() => setReportOpen(false)}
      >
        <Field label="Reason">
          <select
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            className={styles.select}
          >
            <option value="harassment">Harassment</option>
            <option value="spam">Spam</option>
            <option value="inappropriate">Inappropriate content</option>
            <option value="impersonation">Impersonation</option>
            <option value="other">Something else</option>
          </select>
        </Field>

        <Field label="Anything else?" hint="Optional">
          <Textarea
            value={reportDetails}
            onChange={(e) => setReportDetails(e.target.value)}
            placeholder="What happened, and where"
            maxLength={1000}
            rows={3}
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={requestOpen}
        title={`Ask ${profile.displayName} to mentor you?`}
        description="They will see your topic and note, and can accept or decline."
        confirmLabel={requesting ? 'Sending…' : 'Send request'}
        confirmDisabled={requesting || !topic.trim()}
        onConfirm={requestMentorship}
        onCancel={() => setRequestOpen(false)}
      >
        <Field
          label="What do you want help with?"
          hint="Required — it is what they decide on"
        >
          <Input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Backend interview preparation"
            maxLength={120}
            autoFocus
          />
        </Field>

        <Field label="Anything else?" hint="Optional">
          <Textarea
            value={requestMessage}
            onChange={(e) => setRequestMessage(e.target.value)}
            placeholder="Where you are now, and what you are hoping to get out of it"
            maxLength={1000}
            rows={3}
          />
        </Field>
      </ConfirmDialog>
    </AppShell>
  );
}
