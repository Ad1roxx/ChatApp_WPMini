import React, { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { doc, collection, addDoc, serverTimestamp, query, orderBy, getDoc, getDocs } from 'firebase/firestore';
import { db, auth } from "../firebase";
import Avatar from "../components/Avatar";
import MessageBubble from "../components/MessageBubble";
import Composer from "../components/Composer";
import DayDivider from "../components/DayDivider";
import RecordsList from "../components/RecordsList";

const formatMessageTime = (timestamp) => {
  if (!timestamp) return '';
  
  try {
    // Handle Firestore Timestamp
    if (timestamp.toDate) {
      return timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    // Handle ISO string from SSE
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    console.error('Failed to format message time:', err);
    return '';
  }
};

export default function ChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [messages, setMessages] = useState([]);
  const [chat, setChat] = useState(null);
  const listRef = useRef(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [showRecordsModal, setShowRecordsModal] = useState(false);
  const [peerRecords, setPeerRecords] = useState([]);
  const [isComposing, setIsComposing] = useState(false);
  const typingTimeoutRef = useRef(null);
  const [activeUsers, setActiveUsers] = useState(new Set());

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Update activity status
  useEffect(() => {
    if (!auth.currentUser) return;

    const updateActivity = async (isActive) => {
      try {
        const response = await fetch('http://localhost:3001/api/activity/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: auth.currentUser.uid,
            chatId: id,
            isActive
          })
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
      } catch (err) {
        console.error('Failed to update activity:', err);
      }
    };

    console.log('Updating activity to active');
    updateActivity(true);
    
    return () => {
      console.log('Updating activity to inactive');
      updateActivity(false);
      // Also ensure typing state is cleared on leaving the chat
      try {
        fetch('http://localhost:3001/api/typing/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: auth.currentUser.uid, chatId: id, isTyping: false })
        }).catch(() => {});
      } catch (e) {
        // ignore
      }
    };
  }, [id, auth.currentUser]);

  // Typing helpers: expose functions the Composer can call on each keystroke
  const updateTyping = async (isTyping) => {
    if (!auth.currentUser || !id) return;
    try {
      console.log(`[typing] sending update isTyping=${isTyping} for chat ${id}`);
      const response = await fetch('http://localhost:3001/api/typing/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: auth.currentUser.uid,
          chatId: id,
          isTyping
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (err) {
      console.error('Failed to update typing status:', err);
    }
  };

  const startOrRefreshTimer = () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      console.log('[typing] inactivity timer elapsed, clearing typing');
      updateTyping(false);
      typingTimeoutRef.current = null;
    }, 5000);
  };

  // Called by Composer on each change/keydown. This will immediately send
  // a typing=true and refresh the inactivity timer so repeated typing after
  // a pause will re-trigger the indicator even if the boolean state didn't change.
  const handleComposerTyping = (isTypingSignal) => {
    setIsComposing(isTypingSignal);
    if (isTypingSignal) {
      updateTyping(true);
      startOrRefreshTimer();
    } else {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      updateTyping(false);
    }
  };

  // Ensure any pending timer is cleared when the component unmounts
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, []);

  const send = async (text) => {
    const { uid, displayName } = auth.currentUser;
    const now = new Date().toISOString();
    await addDoc(collection(db, "chats", id, "messages"), {
      text: text,
      from: displayName,
      createdAt: now, // Use ISO string instead of serverTimestamp
      uid,
      chatId: id
    });
  };

  // Mark messages as read when entering chat
  useEffect(() => {
    if (auth.currentUser) {
      fetch(`http://localhost:3001/api/chats/${id}/markAsRead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }).catch(err => console.error('Failed to mark messages as read:', err));
    }
  }, [id]);

  useEffect(() => {
    // Connect to server-sent events for live chat updates
    const es = new EventSource(`http://localhost:3001/api/chats/${id}/messages/live`);
    
    es.addEventListener('connected', () => {
      console.log('Connected to chat stream');
    });
    
    es.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        setMessages(current => {
          // Don't add duplicate messages
          if (current.some(m => m.id === msg.id)) return current;
          return [...current, {
            id: msg.id,
            text: msg.text,
            from: msg.from,
            uid: msg.uid,
            createdAt: msg.createdAt,
            mine: msg.uid === auth.currentUser?.uid
          }];
        });
      } catch (err) {
        console.error('Failed to parse chat message event:', err);
      }
    });
    
    es.addEventListener('error', (ev) => {
      console.error('Messages stream error:', ev);
    });

    es.addEventListener('typing', (e) => {
      try {
        const { userId, chatId, isTyping } = JSON.parse(e.data);
        console.log(`[typing event] received for chat ${chatId}: user=${userId} isTyping=${isTyping}`);
        if (chatId === id && userId !== auth.currentUser.uid) {
          setPeerTyping(isTyping);
        }
      } catch (err) {
        console.error('Failed to parse typing event:', err);
      }
    });

    es.addEventListener('activity', (e) => {
      try {
        const { userId, chatId, isActive } = JSON.parse(e.data);
        // Update active users set regardless of chatId to track global user status
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

    // Also get initial chat data and messages
    const fetchInitialData = async () => {
      try {
        const chatDoc = await getDoc(doc(db, "chats", id));
        if (chatDoc.exists()) {
          setChat(chatDoc.data());
        }
        
        const q = query(collection(db, "chats", id, "messages"), orderBy("createdAt"));
        const msgSnap = await getDocs(q);
        const msgs = [];
        msgSnap.forEach(doc => {
          const data = doc.data();
          msgs.push({
            id: doc.id,
            ...data,
            mine: data.uid === auth.currentUser.uid
          });
        });
        setMessages(msgs);
      } catch (err) {
        console.error('Failed to fetch initial chat data:', err);
      }
    };
    
    fetchInitialData();

    return () => es.close();
  }, [id]);

  const getPeerName = () => {
    if (chat) {
      const { uid } = auth.currentUser;
      const peerIndex = chat.users.findIndex(u => u !== uid);
      return chat.userNames[peerIndex];
    }
    return "";
  }

  const peerName = getPeerName();
  const peerId = chat?.users?.find(uid => uid !== auth.currentUser?.uid);

  const openPeerRecords = async () => {
    if (!peerId) return;
    try {
  const userDoc = await getDoc(doc(db, 'users', peerId));
      if (userDoc.exists()) {
        const data = userDoc.data();
        setPeerRecords(data.records || []);
      } else {
        setPeerRecords([]);
      }
      setShowRecordsModal(true);
    } catch (err) {
      console.error('Failed to fetch peer records:', err);
      setPeerRecords([]);
      setShowRecordsModal(true);
    }
  };

  return (
    <div className="chat-page">
      <div className="chat-header">
        <button className="icon-btn" onClick={() => nav(-1)}>
          ←
        </button>
        <Avatar label={peerName ? peerName[0] : "?"} />
        <div className="peer">
          <div className="title" style={{ cursor: 'pointer' }} onClick={openPeerRecords}>{peerName}</div>
          {chat && peerTyping && (
            <div className="typing-indicator">
              <div className="typing-dots small">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div ref={listRef} className="messages">
        <DayDivider label="Today" />
        {messages.map((m) => (
          <MessageBubble 
            key={m.id} 
            mine={m.mine} 
            time={formatMessageTime(m.createdAt)}
          >
            {m.text}
          </MessageBubble>
        ))}
        {peerTyping && (
          <div className="typing-indicator-chat">
            <div className="typing-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}

        {showRecordsModal && (
          <div className="modal" style={{ position: 'fixed', left: 0, top: 0, right:0, bottom:0, background: 'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex: 60 }} onClick={() => setShowRecordsModal(false)}>
            <div style={{ width: 560, maxHeight: '70vh', overflowY: 'auto', background: 'white', padding: 18, borderRadius: 8 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin:0 }}>{peerName}'s Records</h3>
                <button className="btn small" onClick={() => setShowRecordsModal(false)}>Close</button>
              </div>
              <RecordsList records={peerRecords} />
            </div>
          </div>
        )}
      </div>

      <Composer onSend={send} onTyping={handleComposerTyping} />
    </div>
  );
}
