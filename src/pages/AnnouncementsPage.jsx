import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { auth, db } from "../firebase";
import { doc, getDoc } from "firebase/firestore";

export default function AnnouncementsPage() {
  const nav = useNavigate();
  const [announcements, setAnnouncements] = useState([]);
  const [newAnnouncementIds, setNewAnnouncementIds] = useState([]);
  const [newAnnouncement, setNewAnnouncement] = useState("");
  const [isMentor, setIsMentor] = useState(false);
  const inputRef = useRef(null);
  const location = useLocation();
  const messagesEndRef = useRef(null);

  useEffect(() => {
    // Initial fetch
    fetch("http://localhost:3001/api/announcements")
      .then((res) => res.json())
      .then((data) => setAnnouncements(data))
      .catch((err) => console.error('Failed to fetch announcements:', err));

    // Connect to server-sent events for live updates
    const es = new EventSource("http://localhost:3001/api/announcements/live");
    es.addEventListener('connected', () => {
      console.log('Connected to announcements stream');
    });
    es.addEventListener('announcement', (e) => {
      try {
        const ann = JSON.parse(e.data);
        setAnnouncements((cur) => [...cur, ann]);
        if (ann && ann._id) {
          setNewAnnouncementIds((ids) => [...ids, ann._id]);
          // remove the 'new' badge after 5 seconds
          setTimeout(() => {
            setNewAnnouncementIds((ids) => ids.filter((id) => id !== ann._id));
          }, 5000);
        }
      } catch (err) {
        console.error('Failed to parse announcement event', err);
      }
    });
    es.addEventListener('error', (ev) => {
      console.error('Announcements stream error', ev);
      // EventSource will retry automatically; we could implement backoff if desired
    });

    return () => es.close();
  }, []);

  // fetch current user's role from Firestore (if logged in)
  useEffect(() => {
    const checkRole = async () => {
      const user = auth.currentUser;
      if (!user) return setIsMentor(false);
      try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        const data = userDoc.exists() ? userDoc.data() : null;
        setIsMentor(data && data.role === "mentor");
      } catch (err) {
        console.error("Failed to read user role:", err);
        setIsMentor(false);
      }
    };
    checkRole();
    // also listen for auth state changes
    const unsub = auth.onAuthStateChanged(() => checkRole());
    return () => unsub();
  }, []);

  // If navigation requested opening the composer, focus the input when available
  useEffect(() => {
    if (location?.state?.openComposer && isMentor) {
      // small timeout to wait for input render
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [location, isMentor]);
  
  useEffect(() => {
    console.log("Announcements array:", announcements);
  }, [announcements]);

  // Auto-scroll to bottom when announcements change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [announcements]);

  const handleSend = async () => {
    if (!isMentor) {
      alert('Only mentors can post announcements');
      return;
    }
    if (!newAnnouncement.trim()) return;

    const announcement = {
      text: newAnnouncement.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not authenticated');
  // force refresh the token to ensure server sees updated custom claims if any
  const idToken = await user.getIdToken(true);

      const res = await fetch("http://localhost:3001/api/announcements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(announcement),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to post announcement');
      }
      // The server will broadcast the new announcement via SSE; just clear input here
      await res.json();
      setNewAnnouncement("");
    } catch (err) {
      console.error('Announcement send failed', err);
      alert(err.message || 'Failed to send announcement');
    }
  };

  return (
    <div className="chat-page announcements-page">
      <div className="chat-header">
        <button onClick={() => nav("/")} className="back-btn icon-btn">
          &larr;
        </button>
        <div className="peer">
          <div className="title">Announcements</div>
        </div>
      </div>

      <div className="messages">
        {announcements.map((ann, index) => {
          const currentUid = auth.currentUser ? auth.currentUser.uid : null;
          const isMine = ann.authorId && currentUid && ann.authorId === currentUid;
          const isNew = ann._id && newAnnouncementIds.includes(ann._id);
          // ensure non-mine messages get the "theirs" class so CSS styles (background, border-radius)
          // apply consistently the same way as other chat views
          return (
            <div
              key={index}
              className={`bubble ${isMine ? 'mine' : 'theirs'}`}
              style={{ position: 'relative', transition: 'opacity 300ms ease' }}
            >
              {ann.authorDisplayName && (
                <div style={{ fontSize: 12, color: '#444', marginBottom: 4 }}>
                  {ann.authorDisplayName}{' '}
                  {isNew && (
                    <span
                      style={{
                        background: '#ff4757',
                        color: '#fff',
                        padding: '2px 6px',
                        borderRadius: 12,
                        fontSize: 10,
                        marginLeft: 8,
                      }}
                    >
                      New
                    </span>
                  )}
                </div>
              )}
              {ann.text}
              <div className="meta">{ann.time}</div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {isMentor ? (
        <div className="composer">
          <input
            type="text"
            ref={inputRef}
            value={newAnnouncement}
            onChange={(e) => setNewAnnouncement(e.target.value)}
            placeholder="Type an announcement..."
            onKeyPress={(e) => e.key === "Enter" && handleSend()}
          />
          <button onClick={handleSend} className="send icon-btn">
            &#10148;
          </button>
        </div>
      ) : (
        <div style={{ padding: '12px', textAlign: 'center', color: '#666' }}>
          Only mentors can post announcements.
        </div>
      )}
    </div>
  );
}
