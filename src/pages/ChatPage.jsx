/**
 * ChatPage - The actual chat interface
 * 
 * This is where the real-time messaging happens!
 * 
 * How it works:
 * 1. Load message history from server (REST API)
 * 2. Listen for new messages via Socket.IO
 * 3. When user sends a message, emit via Socket.IO
 * 4. Server saves to MongoDB and forwards to receiver
 * 
 * Socket.IO events used:
 * - send-message: Send a new message
 * - new-message: Receive a new message
 * - message-sent: Confirmation that our message was saved
 * - typing / stop-typing: Typing indicators
 */

import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ChatPage() {
  const { peerId } = useParams();  // MongoDB _id of the person we're chatting with
  const navigate = useNavigate();
  const { dbUser, socket, SERVER_URL } = useAuth();
  
  // State
  const [messages, setMessages] = useState([]);
  const [peer, setPeer] = useState(null);  // The other user's info
  const [newMessage, setNewMessage] = useState("");
  const [peerTyping, setPeerTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  
  // Refs
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  /**
   * Scroll to bottom of messages
   */
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Scroll when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  /**
   * Effect: Fetch peer info and message history
   */
  useEffect(() => {
    const fetchData = async () => {
      if (!dbUser) return;
      
      try {
        // Fetch peer info
        const peerRes = await fetch(`${SERVER_URL}/api/user/${peerId}`);
        if (peerRes.ok) {
          const peerData = await peerRes.json();
          setPeer(peerData);
        }

        // Fetch message history
        const msgRes = await fetch(
          `${SERVER_URL}/api/messages/${dbUser._id}/${peerId}`
        );
        if (msgRes.ok) {
          const msgData = await msgRes.json();
          setMessages(msgData);
        }
      } catch (err) {
        console.error("Error fetching chat data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [dbUser, peerId, SERVER_URL]);

  /**
   * Effect: Listen for real-time Socket.IO events
   */
  useEffect(() => {
    if (!socket || !dbUser) return;

    /**
     * Handle incoming message
     * 
     * This fires when the OTHER person sends us a message.
     * We check if it's from/to us before adding to the list.
     */
    const handleNewMessage = (message) => {
      // Only add if it's part of THIS conversation
      const isRelevant = 
        (message.sender._id === peerId && message.receiver._id === dbUser._id) ||
        (message.sender._id === dbUser._id && message.receiver._id === peerId);
      
      if (isRelevant) {
        setMessages(prev => {
          // Avoid duplicates
          if (prev.some(m => m._id === message._id)) return prev;
          return [...prev, message];
        });
        
        // Clear typing indicator when message received
        setPeerTyping(false);

        // If this message came FROM the peer, we've now seen it —
        // tell the server to mark the peer's messages as read.
        const fromPeer = (message.sender._id || message.sender) === peerId;
        if (fromPeer) {
          socket.emit('mark-read', { visitorId: dbUser._id, peerId });
        }
      }
    };

    /**
     * Handle our own message confirmation
     * 
     * This fires after we send a message and server confirms it was saved.
     */
    const handleMessageSent = (message) => {
      setMessages(prev => {
        // Avoid duplicates
        if (prev.some(m => m._id === message._id)) return prev;
        return [...prev, message];
      });
    };

    /**
     * Handle typing indicator
     */
    const handlePeerTyping = ({ senderId }) => {
      if (senderId === peerId) {
        setPeerTyping(true);
      }
    };

    const handlePeerStopTyping = ({ senderId }) => {
      if (senderId === peerId) {
        setPeerTyping(false);
      }
    };

    /**
     * Handle read receipt: the peer has read our messages.
     *
     * byVisitor is whoever did the reading. If that's the peer we're
     * chatting with, flip all of OUR sent messages to read = true so
     * the UI can show "Seen".
     */
    const handleMessagesRead = ({ byVisitor }) => {
      if (byVisitor !== peerId) return;
      setMessages(prev =>
        prev.map(m => {
          const senderId = m.sender._id || m.sender;
          return senderId === dbUser._id ? { ...m, read: true } : m;
        })
      );
    };

    // Register listeners
    socket.on('new-message', handleNewMessage);
    socket.on('message-sent', handleMessageSent);
    socket.on('user-typing', handlePeerTyping);
    socket.on('user-stop-typing', handlePeerStopTyping);
    socket.on('messages-read', handleMessagesRead);

    // On opening the chat, mark any already-unread messages from the
    // peer as read (covers history that arrived before we opened it).
    socket.emit('mark-read', { visitorId: dbUser._id, peerId });

    // Cleanup on unmount
    return () => {
      socket.off('new-message', handleNewMessage);
      socket.off('message-sent', handleMessageSent);
      socket.off('user-typing', handlePeerTyping);
      socket.off('user-stop-typing', handlePeerStopTyping);
      socket.off('messages-read', handleMessagesRead);

      // Clear typing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [socket, dbUser, peerId]);

  /**
   * Send a message
   */
  const sendMessage = (e) => {
    e.preventDefault();
    
    if (!newMessage.trim() || !socket || !dbUser) return;

    // Emit message via Socket.IO
    socket.emit('send-message', {
      senderId: dbUser._id,
      receiverId: peerId,
      text: newMessage.trim()
    });

    // Clear input
    setNewMessage("");
    
    // Stop typing indicator
    socket.emit('stop-typing', {
      senderId: dbUser._id,
      receiverId: peerId
    });
  };

  /**
   * Handle typing in input field
   */
  const handleInputChange = (e) => {
    setNewMessage(e.target.value);
    
    if (!socket || !dbUser) return;

    // Send typing indicator
    socket.emit('typing', {
      senderId: dbUser._id,
      receiverId: peerId
    });

    // Clear previous timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop typing indicator after 2 seconds of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop-typing', {
        senderId: dbUser._id,
        receiverId: peerId
      });
    }, 2000);
  };

  /**
   * Format timestamp for display
   */
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  // Loading state
  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading chat...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button onClick={() => navigate('/users')} style={styles.backBtn}>
          ← Back
        </button>
        <div style={styles.peerInfo}>
          {peer?.photoURL ? (
            <img src={peer.photoURL} alt="" style={styles.headerAvatar} />
          ) : (
            <div style={styles.headerAvatarPlaceholder}>
              {peer?.displayName?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
          <div>
            <div style={styles.peerName}>{peer?.displayName || 'Unknown'}</div>
            {peerTyping && (
              <div style={styles.typingText}>typing...</div>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={styles.messagesContainer}>
        {messages.length === 0 ? (
          <div style={styles.emptyChat}>
            <p>No messages yet</p>
            <p style={styles.emptyHint}>Say hello! 👋</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isMine = msg.sender._id === dbUser._id || msg.sender === dbUser._id;
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
                  <div style={styles.messageText}>{msg.text}</div>
                  <div style={{
                    ...styles.messageTime,
                    color: isMine ? 'rgba(255,255,255,0.7)' : '#9ca3af'
                  }}>
                    {formatTime(msg.timestamp)}
                    {/* Read receipt on our own messages only */}
                    {isMine && (
                      <span style={styles.readStatus}>
                        {msg.read ? ' ✓✓ Seen' : ' ✓ Sent'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        
        {/* Typing indicator */}
        {peerTyping && (
          <div style={styles.messageRow}>
            <div style={{...styles.messageBubble, ...styles.theirMessage, ...styles.typingBubble}}>
              <div style={styles.typingDots}>
                <span style={styles.dot}></span>
                <span style={{...styles.dot, animationDelay: '0.2s'}}></span>
                <span style={{...styles.dot, animationDelay: '0.4s'}}></span>
              </div>
            </div>
          </div>
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
        <button 
          type="submit" 
          style={styles.sendBtn}
          disabled={!newMessage.trim()}
        >
          Send
        </button>
      </form>

      {/* Typing animation CSS */}
      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

// Styles
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
  peerInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  },
  headerAvatar: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    objectFit: 'cover'
  },
  headerAvatarPlaceholder: {
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
  peerName: {
    fontWeight: '600',
    fontSize: '16px'
  },
  typingText: {
    fontSize: '12px',
    opacity: 0.8,
    fontStyle: 'italic'
  },
  messagesContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  messageRow: {
    display: 'flex',
    width: '100%'
  },
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
  messageText: {
    fontSize: '15px',
    lineHeight: '1.4'
  },
  messageTime: {
    fontSize: '11px',
    marginTop: '4px',
    textAlign: 'right'
  },
  readStatus: {
    marginLeft: '4px',
    fontSize: '11px',
    fontWeight: '500'
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
  emptyChat: {
    textAlign: 'center',
    color: '#6b7280',
    marginTop: '40%'
  },
  emptyHint: {
    fontSize: '24px',
    marginTop: '8px'
  },
  typingBubble: {
    padding: '14px 18px'
  },
  typingDots: {
    display: 'flex',
    gap: '4px'
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#9ca3af',
    animation: 'bounce 1s infinite'
  }
};
