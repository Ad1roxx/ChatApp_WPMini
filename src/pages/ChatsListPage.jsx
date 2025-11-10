import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { collection, query, where, getDocs, doc, getDoc, addDoc } from "firebase/firestore";
import { db, auth } from "../firebase";
import NewChatModal from "../components/NewChatModal";

export default function ChatsListPage() {
  const navigate = useNavigate();
  const [announcements, setAnnouncements] = useState([]);
  const lastAnnouncement = announcements.length > 0 ? announcements[announcements.length - 1] : null;
  const [chats, setChats] = useState([]);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [recentChats, setRecentChats] = useState([]);
  const [userRole, setUserRole] = useState(null);
  const [announcementAuthor, setAnnouncementAuthor] = useState(null);
  const [typingStatuses, setTypingStatuses] = useState({});
  const [activeUsers, setActiveUsers] = useState(new Set());

  useEffect(() => {
    // Connect to SSE for live chat updates
    const es = new EventSource("http://localhost:3001/api/chats/live");
    
    es.addEventListener('connected', () => {
      console.log('Connected to chats stream');
    });
    
    es.addEventListener('chat', (e) => {
      try {
        const chat = JSON.parse(e.data);
        // Only add chat if we're a participant
        if (auth.currentUser && chat.users.includes(auth.currentUser.uid)) {
          setChats(current => {
            if (current.some(c => c.id === chat.id)) return current;
            return [...current, chat];
          });
          // Also add to recent chats if it's new
          setRecentChats(current => {
            if (current.some(c => c.id === chat.id)) return current;
            const peerName = chat.userNames[chat.users.findIndex(id => id !== auth.currentUser.uid)];
            return [...current, { id: chat.id, title: peerName, time: chat.createdAt }];
          });
        }
      } catch (err) {
        console.error('Failed to parse chat event:', err);
      }
    });

    es.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        console.log('Message received:', msg);
      } catch (err) {
        console.error('Failed to parse message event:', err);
      }
    });

    es.addEventListener('error', (ev) => {
      console.error('Chats stream error:', ev);
    });

    es.addEventListener('typing', (e) => {
      try {
        const { userId, chatId, isTyping } = JSON.parse(e.data);
        if (auth.currentUser && userId !== auth.currentUser.uid) {
          setTypingStatuses(current => ({
            ...current,
            [chatId]: isTyping ? userId : null
          }));
        }
      } catch (err) {
        console.error('Failed to parse typing event:', err);
      }
    });

    es.addEventListener('activity', (e) => {
      try {
        const { userId, isActive } = JSON.parse(e.data);
        setActiveUsers(current => {
          const newSet = new Set(current);
          if (isActive) {
            newSet.add(userId);
          } else {
            newSet.delete(userId);
          }
          return newSet;
        });
      } catch (err) {
        console.error('Failed to parse activity event:', err);
      }
    });

    // Wait for auth to be ready before doing any Firestore reads that require auth
    let unsubAuth = null;

    const doFetches = async (user) => {
      try {
        // Announcements are public from the server backend
        const res = await fetch("http://localhost:3001/api/announcements");
        const data = await res.json();
        setAnnouncements(data);

        // if there's a latest announcement with authorId, try to fetch author's displayName
        const latest = data && data.length ? data[data.length - 1] : null;
        if (latest && latest.authorId) {
          console.log('[ChatsListPage] attempting to fetch announcement author for', latest.authorId);
          try {
            const userDoc = await getDoc(doc(db, "users", latest.authorId));
            if (userDoc.exists()) {
              console.log('[ChatsListPage] announcement author doc found');
              setAnnouncementAuthor(userDoc.data().displayName || 'Mentor');
            } else {
              console.log('[ChatsListPage] announcement author doc does not exist');
              setAnnouncementAuthor('Mentor');
            }
          } catch (err) {
            console.error('[ChatsListPage] Failed to fetch announcement author:', err);
            setAnnouncementAuthor('Mentor');
          }
        } else {
          setAnnouncementAuthor('Mentor');
        }

        // user-specific reads (require auth)
        try {
          console.log('[ChatsListPage] attempting to read current user doc for', user.uid);
          const userDoc = await getDoc(doc(db, "users", user.uid));
          if (userDoc.exists()) {
            setUserRole(userDoc.data().role);
          } else {
            console.log('[ChatsListPage] current user doc does not exist');
          }
        } catch (err) {
          console.error('[ChatsListPage] read current user doc failed:', err);
        }

        try {
          console.log('[ChatsListPage] querying chats for', user.uid);
          const q = query(collection(db, "chats"), where("users", "array-contains", user.uid));
          const querySnapshot = await getDocs(q);
          const chatData = [];
          querySnapshot.forEach((d) => {
            chatData.push({ id: d.id, ...d.data() });
          });
          setChats(chatData);
        } catch (err) {
          console.error('[ChatsListPage] chats query failed:', err);
        }
      } catch (err) {
        console.error('Firestore fetch failed:', err);
      }
    };

    const init = async () => {
      const user = auth.currentUser;
      if (user) {
        await doFetches(user);
      } else {
        // wait for sign-in to complete then run fetches
        unsubAuth = auth.onAuthStateChanged(async (u) => {
          if (u) {
            await doFetches(u);
            if (unsubAuth) unsubAuth();
          }
        });
      }
    };

    init();
    return () => { if (unsubAuth) unsubAuth(); };
  }, []);

  const createOrOpenChatWith = async (otherUid, otherDisplayName) => {
    try {
      const me = auth.currentUser;
      if (!me) throw new Error('Not authenticated');

      // check if chat already exists between the two users
      const q = query(collection(db, "chats"), where("users", "array-contains", me.uid));
      const snap = await getDocs(q);
      let existing = null;
      snap.forEach((d) => {
        const data = d.data();
        if (data.users && data.users.includes(otherUid)) {
          existing = { id: d.id, ...data };
        }
      });

      if (existing) {
        // push to recentChats if not present
        setRecentChats((r) => {
          if (r.find((c) => c.id === existing.id)) return r;
          return [{ id: existing.id, title: otherDisplayName, time: existing.createdAt || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...r];
        });
        setShowNewChatModal(false);
        return;
      }

      // create a new chat document
      const newDoc = await addDoc(collection(db, "chats"), {
        users: [me.uid, otherUid],
        userNames: [me.displayName || 'You', otherDisplayName || 'Peer'],
        createdAt: new Date().toISOString(),
      });

      const chatObj = { id: newDoc.id, users: [me.uid, otherUid], userNames: [me.displayName || 'You', otherDisplayName || 'Peer'], createdAt: new Date().toISOString() };

      setChats((c) => [...c, chatObj]);
      setRecentChats((r) => [{ id: chatObj.id, title: otherDisplayName, time: chatObj.createdAt }, ...r]);
      setShowNewChatModal(false);
    } catch (err) {
      console.error('Failed to create/open chat:', err);
      alert('Failed to create chat');
    }
  }

    const handleChatClick = (chatId) => {
        navigate(`/chat/${chatId}`);
    };  const openNewChat = () => {
    // small debug log to ensure click works and state changes
    console.log('New Chat button clicked - opening modal');
    setShowNewChatModal(true);
  };
  
  const getPeerName = (chat) => {
    const { uid } = auth.currentUser;
    const peerIndex = chat.users.findIndex(u => u !== uid);
    return chat.userNames[peerIndex];
  }


  return (
    <div className="mentor-chats-page">
        {lastAnnouncement && (
            <div className="announcements-section" onClick={() => navigate("/announcements") }>
                <div className="announcements-bar">
                <div className="announcement-info">
                        <div className="announcement-avatar" aria-hidden>
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M3 11v2a1 1 0 0 0 1 1h2l4 3V7L6 10H4a1 1 0 0 0-1 1z" fill="#1f2937" />
                            <path d="M16 7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3v-2a1 1 0 0 0-1-1h-1v-4h1a1 1 0 0 0 1-1V7z" fill="#4f46e5" />
                          </svg>
                        </div>
                    <div>
                      <div style={{fontWeight:600}}>{announcementAuthor ? `Mentor: ${announcementAuthor}` : 'Mentor'}</div>
                      <p className="announcement-text">{lastAnnouncement.text}</p>
                    </div>
                </div>
                <div style={{display:'flex', alignItems:'center'}}>
                  <span className="announcement-time" style={{marginRight:12}}>{lastAnnouncement.time}</span>
                  {userRole === 'mentor' && (
                    <button className="btn small" onClick={(e) => { e.stopPropagation(); navigate('/announcements', { state: { openComposer: true } }); }}>
                      + Add
                    </button>
                  )}
                </div>
                </div>
            </div>
        )}

      {/* NewChatModal rendered when requested */}
      <NewChatModal open={showNewChatModal} onClose={() => setShowNewChatModal(false)} onCreateChat={createOrOpenChatWith} />

      <div className="group-chat-section" onClick={() => navigate('/chat/group')}>
        <div className="group-chat-avatar">G</div>
        <div className="group-chat-info">
          <p className="group-chat-name">Group Chat</p>
          <div className="group-chat-preview">
            <p>Mentor: Remember the deadline...</p>
            <span className="time">12:30 PM</span>
          </div>
        </div>
      </div>

      <div className="student-list-header">Chats</div>

      <div style={{display:'flex', alignItems:'center', gap:12, padding: '6px 12px'}}>
        <button className="btn" onClick={() => setShowNewChatModal(true)}>New Chat</button>
        {userRole === 'mentor' && (
          <button className="btn" onClick={() => navigate("/mentor/users")}>Find a Student</button>
        )}
      </div>

      <div className="student-list">
        {/* Show recent chats first, then existing chats */}
        {recentChats.map((rc) => (
          <div key={rc.id} className="chat-item" onClick={() => handleChatClick(rc.id)}>
            <div className="avatar">{rc.title.charAt(0)}</div>
            <div className="chat-meta">
              <h4 className="name">{rc.title}</h4>
              <div className="preview-line">
                {typingStatuses[rc.id] ? (
                  <p className="preview typing-indicator-bar" style={{ paddingLeft: 0 }}>typing...</p>
                ) : (
                  <p className="preview">New conversation</p>
                )}
              </div>
            </div>
          </div>
        ))}
        {chats.filter(chat => !recentChats.find(rc => rc.id === chat.id)).map((chat) => (
          <div key={chat.id} className="chat-item" onClick={() => handleChatClick(chat.id)}>
            <div className="avatar">{getPeerName(chat).charAt(0)}</div>
            <div className="chat-meta">
              <h4 className="name">{getPeerName(chat)}</h4>
              <div className="preview-line">
                {typingStatuses[chat.id] ? (
                  <p className="preview typing-indicator-bar" style={{ paddingLeft: 0 }}>typing...</p>
                ) : (
                  <p className="preview">No messages yet</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* bottom Find a Student button removed; button is rendered inline above */}
    </div>
  );
}
