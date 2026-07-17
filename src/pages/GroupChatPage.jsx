/**
 * GroupChatPage - Real-time group chat
 *
 * A near-mirror of ChatPage, but for a group:
 * 1. Load group info + message history via REST
 * 2. Join the group's Socket.IO room (join-group)
 * 3. Send via 'send-group-message'; render on the 'new-group-message'
 *    broadcast (the server echoes our own message back to the room, so we
 *    do NOT optimistically add it here)
 * 4. Typing indicators via 'group-typing' / 'group-user-typing'
 * 5. Leave the room on unmount (leave-group)
 */

import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function GroupChatPage() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { dbUser, socket, SERVER_URL } = useAuth();

  const [group, setGroup] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [typingUsers, setTypingUsers] = useState({});  // senderId -> displayName
  const [loading, setLoading] = useState(true);

  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, typingUsers]);

  /**
   * Effect: fetch group info + message history.
   *
   * We reuse GET /api/groups?userId=<me> and find this group in the list
   * (it's populated with member names), then load its messages.
   */
  useEffect(() => {
    const fetchData = async () => {
      if (!dbUser) return;
      try {
        // Group info (name + members) — find it among the user's groups
        const groupsRes = await fetch(
          `${SERVER_URL}/api/groups?userId=${dbUser._id}`
        );
        if (groupsRes.ok) {
          const myGroups = await groupsRes.json();
          setGroup(myGroups.find((g) => g._id === groupId) || null);
        }

        // Message history
        const msgRes = await fetch(
          `${SERVER_URL}/api/groups/${groupId}/messages`
        );
        if (msgRes.ok) setMessages(await msgRes.json());
      } catch (err) {
        console.error('Error fetching group chat data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [dbUser, groupId, SERVER_URL]);

  /**
   * Effect: join the room and wire up live events.
   */
  useEffect(() => {
    if (!socket || !dbUser) return;

    // Join this group's Socket.IO room
    socket.emit('join-group', groupId);

    const handleNewMessage = (message) => {
      if (message.group !== groupId) return;  // ignore other groups
      setMessages((prev) => {
        if (prev.some((m) => m._id === message._id)) return prev;  // dedupe
        return [...prev, message];
      });
      // Clear that sender's typing indicator once their message arrives
      setTypingUsers((prev) => {
        const next = { ...prev };
        delete next[message.sender?._id];
        return next;
      });
    };

    const handleTyping = ({ groupId: gId, senderId }) => {
      if (gId !== groupId || senderId === dbUser._id) return;
      const name = memberName(senderId);
      setTypingUsers((prev) => ({ ...prev, [senderId]: name }));
    };

    const handleStopTyping = ({ groupId: gId, senderId }) => {
      if (gId !== groupId) return;
      setTypingUsers((prev) => {
        const next = { ...prev };
        delete next[senderId];
        return next;
      });
    };

    socket.on('new-group-message', handleNewMessage);
    socket.on('group-user-typing', handleTyping);
    socket.on('group-user-stop-typing', handleStopTyping);

    return () => {
      socket.emit('leave-group', groupId);
      socket.off('new-group-message', handleNewMessage);
      socket.off('group-user-typing', handleTyping);
      socket.off('group-user-stop-typing', handleStopTyping);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, dbUser, groupId, group]);

  /**
   * Look up a member's display name from the loaded group.
   */
  const memberName = (userId) => {
    const m = group?.members?.find((mem) => (mem._id || mem) === userId);
    return m?.displayName || 'Someone';
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !socket || !dbUser) return;

    socket.emit('send-group-message', {
      groupId,
      senderId: dbUser._id,
      text: newMessage.trim()
    });

    setNewMessage('');
    socket.emit('group-stop-typing', { groupId, senderId: dbUser._id });
  };

  const handleInputChange = (e) => {
    setNewMessage(e.target.value);
    if (!socket || !dbUser) return;

    socket.emit('group-typing', { groupId, senderId: dbUser._id });

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('group-stop-typing', { groupId, senderId: dbUser._id });
    }, 2000);
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Build the "X is typing..." line from the typingUsers map
  const typingNames = Object.values(typingUsers);
  const typingLabel =
    typingNames.length === 0
      ? ''
      : typingNames.length === 1
      ? `${typingNames[0]} is typing...`
      : `${typingNames.slice(0, 2).join(', ')}${
          typingNames.length > 2 ? ' and others' : ''
        } are typing...`;

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading group...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button onClick={() => navigate('/groups')} style={styles.backBtn}>
          ← Back
        </button>
        <div style={styles.peerInfo}>
          <div style={styles.headerAvatar}>
            {group?.name?.charAt(0)?.toUpperCase() || 'G'}
          </div>
          <div>
            <div style={styles.peerName}>{group?.name || 'Group'}</div>
            <div style={styles.memberCount}>
              {group?.members?.length || 0} members
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={styles.messagesContainer}>
        {messages.length === 0 ? (
          <div style={styles.emptyChat}>
            <p>No messages yet</p>
            <p style={styles.emptyHint}>Start the conversation! 👋</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const senderId = msg.sender?._id || msg.sender;
            const isMine = senderId === dbUser._id;
            return (
              <div
                key={msg._id || index}
                style={{
                  ...styles.messageRow,
                  justifyContent: isMine ? 'flex-end' : 'flex-start'
                }}
              >
                <div
                  style={{
                    ...styles.messageBubble,
                    ...(isMine ? styles.myMessage : styles.theirMessage)
                  }}
                >
                  {/* Show sender name above incoming (not mine) messages */}
                  {!isMine && (
                    <div style={styles.senderName}>
                      {msg.sender?.displayName || 'Unknown'}
                    </div>
                  )}
                  <div style={styles.messageText}>{msg.text}</div>
                  <div
                    style={{
                      ...styles.messageTime,
                      color: isMine ? 'rgba(255,255,255,0.7)' : '#9ca3af'
                    }}
                  >
                    {formatTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {typingLabel && (
          <div style={styles.typingRow}>{typingLabel}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={sendMessage} style={styles.inputContainer}>
        <input
          type="text"
          value={newMessage}
          onChange={handleInputChange}
          placeholder="Type a message..."
          style={styles.input}
        />
        <button type="submit" style={styles.sendBtn} disabled={!newMessage.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

// Styles — same visual language as ChatPage
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#f5f5f5'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 16px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    gap: '12px'
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#fff',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '8px'
  },
  peerInfo: { display: 'flex', alignItems: 'center', gap: '12px' },
  headerAvatar: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    backgroundColor: 'rgba(255,255,255,0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px',
    fontWeight: '600'
  },
  peerName: { fontWeight: '600', fontSize: '16px' },
  memberCount: { fontSize: '12px', opacity: 0.8 },
  messagesContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  messageRow: { display: 'flex', width: '100%' },
  messageBubble: {
    maxWidth: '70%',
    padding: '10px 14px',
    borderRadius: '16px',
    wordWrap: 'break-word'
  },
  myMessage: {
    backgroundColor: '#3b82f6',
    color: '#fff',
    borderBottomRightRadius: '4px'
  },
  theirMessage: {
    backgroundColor: '#fff',
    color: '#1f2937',
    borderBottomLeftRadius: '4px',
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
  },
  senderName: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#3b82f6',
    marginBottom: '2px'
  },
  messageText: { fontSize: '15px', lineHeight: '1.4' },
  messageTime: { fontSize: '11px', marginTop: '4px', textAlign: 'right' },
  typingRow: {
    fontSize: '13px',
    color: '#6b7280',
    fontStyle: 'italic',
    padding: '4px 8px'
  },
  inputContainer: {
    display: 'flex',
    padding: '12px 16px',
    backgroundColor: '#fff',
    gap: '12px',
    borderTop: '1px solid #e5e7eb'
  },
  input: {
    flex: 1,
    padding: '12px 16px',
    borderRadius: '24px',
    border: '1px solid #e5e7eb',
    fontSize: '15px',
    outline: 'none'
  },
  sendBtn: {
    padding: '12px 24px',
    backgroundColor: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '24px',
    fontSize: '15px',
    fontWeight: '500',
    cursor: 'pointer'
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    fontSize: '16px',
    color: '#6b7280'
  },
  emptyChat: { textAlign: 'center', color: '#6b7280', marginTop: '40%' },
  emptyHint: { fontSize: '24px', marginTop: '8px' }
};
