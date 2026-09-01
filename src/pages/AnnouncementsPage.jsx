/**
 * AnnouncementsPage - Mentor broadcasts, read by everyone
 *
 * The third message shape in the app, after 1-to-1 chat and group chat:
 * one author, no recipient, everybody reads. Mentors get a compose box at
 * the top; students get the feed only.
 *
 * Like GroupsPage, hiding the compose box for students is convenience —
 * POST /api/announcements independently refuses anyone whose stored role
 * is not 'mentor'.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Card from '../components/Card';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import { Field, Textarea } from '../components/Field';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { InlineLoader } from '../components/Loading';
import { useToast } from '../components/Toast';
import { AnnouncementIcon } from '../components/Icons';
import { canMentor } from '../lib/roles';
import styles from './AnnouncementsPage.module.css';

export default function AnnouncementsPage() {
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();

  const isMentor = canMentor(dbUser?.role);

  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  // Which announcement the confirm dialog is asking about (null = closed)
  const [pendingDelete, setPendingDelete] = useState(null);

  /**
   * Effect: load the feed once.
   *
   * After this, the socket listeners below keep it current — there is no
   * polling and no refetch on post, because the server broadcasts to
   * everyone including the poster.
   */
  useEffect(() => {
    const fetchAnnouncements = async () => {
      try {
        const res = await authFetch('/api/announcements');
        if (res.ok) setAnnouncements(await res.json());
      } catch (err) {
        console.error('Error fetching announcements:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchAnnouncements();
  }, [authFetch]);

  /**
   * Effect: live updates.
   *
   * The server io.emit()s to every connected socket rather than to a room,
   * because announcements are public — there is no room that means
   * "everyone". So both handlers apply unconditionally.
   */
  useEffect(() => {
    if (!socket) return;

    const handleNew = (announcement) => {
      // Prepend: the feed is newest-first
      setAnnouncements(prev => [announcement, ...prev]);
    };

    const handleDeleted = ({ _id }) => {
      setAnnouncements(prev => prev.filter(a => a._id !== _id));
    };

    socket.on('new-announcement', handleNew);
    socket.on('announcement-deleted', handleDeleted);

    return () => {
      socket.off('new-announcement', handleNew);
      socket.off('announcement-deleted', handleDeleted);
    };
  }, [socket]);

  /**
   * Post an announcement. The new one arrives back through the socket
   * broadcast like everyone else's, so we only clear the box here.
   */
  const handlePost = async (e) => {
    e.preventDefault();
    if (!text.trim() || !dbUser) return;

    setPosting(true);
    try {
      // No authorId: the server takes the author from the token.
      const res = await authFetch('/api/announcements', {
        method: 'POST',
        body: JSON.stringify({ text: text.trim() })
      });

      if (res.ok) {
        setText('');
        toast.success('Announcement posted');
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Failed to post announcement');
      }
    } catch (err) {
      console.error('Error posting announcement:', err);
      toast.error('Failed to post announcement');
    } finally {
      setPosting(false);
    }
  };

  /**
   * Delete one of your own. The server re-checks authorship, so this
   * button being hidden for other people's posts is not the protection.
   */
  const handleDelete = async () => {
    const id = pendingDelete;
    setPendingDelete(null);
    if (!id) return;

    try {
      const res = await authFetch(`/api/announcements/${id}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Failed to delete announcement');
      }
      // On success the socket broadcast removes it from the list
    } catch (err) {
      console.error('Error deleting announcement:', err);
      toast.error('Failed to delete announcement');
    }
  };

  /**
   * Date + time, unlike the chat pages' time-only format. A chat bubble
   * sits in a conversation you are already reading in order; an
   * announcement from three weeks ago needs to say so.
   */
  const formatWhen = (timestamp) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <AppShell
      title="Announcements"
      subtitle={isMentor ? 'Post a notice for everyone' : 'Notices from your mentors'}
    >
      {/* Compose box — mentors only */}
      {isMentor ? (
        <Card title="New announcement">
          <form onSubmit={handlePost} className={styles.form}>
            <Field count={text.length} max={2000}>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Something everyone should know…"
                maxLength={2000}
                rows={3}
              />
            </Field>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={posting}
                disabled={!text.trim()}
              >
                {posting ? 'Posting' : 'Post'}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>Only mentors can post announcements</p>
          <p className={styles.noticeText}>You&rsquo;ll see everything they post here.</p>
        </div>
      )}

      {/* Feed */}
      {loading ? (
        <Card>
          <InlineLoader label="Loading announcements" />
        </Card>
      ) : announcements.length === 0 ? (
        <Card>
          <EmptyState
            icon={<AnnouncementIcon size={20} />}
            title="No announcements yet"
            description={
              isMentor
                ? 'Post the first one above — everyone will see it straight away.'
                : 'When a mentor posts a notice it will appear here.'
            }
          />
        </Card>
      ) : (
        announcements.map((a) => {
          const isMine = (a.author?._id || a.author) === dbUser?._id;

          return (
            <Card key={a._id}>
              <div className={styles.header}>
                <Avatar src={a.author?.photoURL} name={a.author?.displayName} size="sm" />

                <div className={styles.headerText}>
                  <button
                    type="button"
                    className={styles.author}
                    onClick={() => a.author?._id && navigate(`/users/${a.author._id}`)}
                  >
                    {a.author?.displayName || 'Unknown'}
                  </button>
                  <span className={styles.when}>{formatWhen(a.timestamp)}</span>
                </div>

                {/* Delete is offered only on your own posts; the server
                    checks authorship regardless. */}
                {isMine && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingDelete(a._id)}
                  >
                    Delete
                  </Button>
                )}
              </div>

              <p className={styles.body}>{a.text}</p>
            </Card>
          );
        })
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this announcement?"
        description="It will disappear for everyone immediately. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </AppShell>
  );
}
