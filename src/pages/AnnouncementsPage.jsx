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

export default function AnnouncementsPage() {
  const navigate = useNavigate();
  const { dbUser, socket, SERVER_URL } = useAuth();

  const isMentor = dbUser?.role === 'mentor';

  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

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
        const res = await fetch(`${SERVER_URL}/api/announcements`);
        if (res.ok) setAnnouncements(await res.json());
      } catch (err) {
        console.error('Error fetching announcements:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchAnnouncements();
  }, [SERVER_URL]);

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
      const res = await fetch(`${SERVER_URL}/api/announcements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorId: dbUser._id, text: text.trim() })
      });

      if (res.ok) {
        setText('');
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to post announcement');
      }
    } catch (err) {
      console.error('Error posting announcement:', err);
      alert('Failed to post announcement');
    } finally {
      setPosting(false);
    }
  };

  /**
   * Delete one of your own. The server re-checks authorship, so this
   * button being hidden for other people's posts is not the protection.
   */
  const handleDelete = async (id) => {
    if (!window.confirm('Delete this announcement? Everyone will lose it.')) return;

    try {
      const res = await fetch(`${SERVER_URL}/api/announcements/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: dbUser._id })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to delete announcement');
      }
      // On success the socket broadcast removes it from the list
    } catch (err) {
      console.error('Error deleting announcement:', err);
      alert('Failed to delete announcement');
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
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Announcements</h1>
          <p style={styles.subtitle}>
            {isMentor
              ? 'Post a notice for everyone'
              : 'Notices from your mentors'}
          </p>
        </div>
        <button onClick={() => navigate('/users')} style={styles.navBtn}>
          Messages
        </button>
      </div>

      <div style={styles.body}>
        {/* Compose box — mentors only */}
        {isMentor ? (
          <form onSubmit={handlePost} style={styles.card}>
            <h2 style={styles.sectionTitle}>New announcement</h2>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Something everyone should know..."
              rows={3}
              maxLength={2000}
              style={styles.textarea}
            />
            <div style={styles.composeFooter}>
              <span style={styles.counter}>{text.length}/2000</span>
              <button
                type="submit"
                style={styles.postBtn}
                disabled={posting || !text.trim()}
              >
                {posting ? 'Posting...' : 'Post'}
              </button>
            </div>
          </form>
        ) : (
          <div style={styles.noticeCard}>
            <span style={styles.noticeIcon}>ℹ️</span>
            <div>
              <p style={styles.noticeTitle}>Only mentors can post announcements</p>
              <p style={styles.noticeText}>
                You'll see everything they post here.
              </p>
            </div>
          </div>
        )}

        {/* Feed */}
        {loading ? (
          <p style={styles.emptyHint}>Loading announcements...</p>
        ) : announcements.length === 0 ? (
          <div style={styles.card}>
            <p style={styles.emptyHint}>
              {isMentor
                ? 'No announcements yet. Post the first one above.'
                : 'No announcements yet.'}
            </p>
          </div>
        ) : (
          announcements.map((a) => {
            const isMine = (a.author?._id || a.author) === dbUser?._id;

            return (
              <div key={a._id} style={styles.card}>
                <div style={styles.authorRow}>
                  {a.author?.photoURL ? (
                    <img src={a.author.photoURL} alt="" style={styles.avatar} />
                  ) : (
                    <div style={styles.avatarPlaceholder}>
                      {a.author?.displayName?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                  )}
                  <div style={styles.authorInfo}>
                    <span
                      style={styles.authorName}
                      onClick={() =>
                        a.author?._id && navigate(`/users/${a.author._id}`)
                      }
                    >
                      {a.author?.displayName || 'Unknown'}
                    </span>
                    <span style={styles.when}>{formatWhen(a.timestamp)}</span>
                  </div>

                  {/* Delete is offered only on your own posts; the server
                      checks authorship regardless. */}
                  {isMine && (
                    <button
                      onClick={() => handleDelete(a._id)}
                      style={styles.deleteBtn}
                      title="Delete announcement"
                    >
                      Delete
                    </button>
                  )}
                </div>

                <p style={styles.text}>{a.text}</p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', backgroundColor: '#f5f5f5' },
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
  card: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    display: 'flex',
    flexDirection: 'column'
  },
  sectionTitle: {
    margin: '0 0 12px',
    fontSize: '18px',
    fontWeight: '600',
    color: '#1f2937'
  },
  textarea: {
    padding: '12px 14px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '15px',
    outline: 'none',
    resize: 'vertical',
    fontFamily: 'inherit',
    boxSizing: 'border-box'
  },
  composeFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '12px'
  },
  counter: { fontSize: '12px', color: '#9ca3af' },
  postBtn: {
    padding: '10px 24px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '15px',
    fontWeight: '500',
    cursor: 'pointer'
  },
  authorRow: { display: 'flex', alignItems: 'center', gap: '12px' },
  avatar: { width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' },
  avatarPlaceholder: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    backgroundColor: '#3b82f6',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '17px',
    fontWeight: '600'
  },
  authorInfo: { flex: 1, display: 'flex', flexDirection: 'column' },
  authorName: {
    fontSize: '15px',
    fontWeight: '600',
    color: '#1f2937',
    cursor: 'pointer'
  },
  when: { fontSize: '13px', color: '#6b7280', marginTop: '2px' },
  deleteBtn: {
    padding: '6px 12px',
    backgroundColor: '#fff',
    color: '#dc2626',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer'
  },
  text: {
    margin: '14px 0 0',
    fontSize: '15px',
    color: '#1f2937',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap'   // keep the line breaks the mentor typed
  },
  noticeCard: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-start',
    backgroundColor: '#eef2ff',
    border: '1px solid #dbeafe',
    borderRadius: '12px',
    padding: '16px 20px'
  },
  noticeIcon: { fontSize: '18px', lineHeight: 1.4 },
  noticeTitle: {
    margin: 0,
    fontSize: '15px',
    fontWeight: '600',
    color: '#1f2937'
  },
  noticeText: {
    margin: '4px 0 0',
    fontSize: '14px',
    color: '#4b5563',
    lineHeight: 1.5
  },
  emptyHint: { color: '#6b7280', fontSize: '14px', margin: 0 }
};
