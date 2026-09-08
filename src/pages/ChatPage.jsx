/**
 * ChatPage - The actual chat interface
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
 * - mark-read / messages-read: Read receipts
 *
 * Uses AppShell's `flush` variant: the transcript scrolls inside its own
 * region while the composer stays pinned to the bottom, so the page itself
 * never scrolls.
 */

import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import { RoleBadge } from '../components/Badge';
import { PageLoader } from '../components/Loading';
import { SendIcon } from '../components/Icons';
// Shared with GroupChatPage — the bubbles, transcript and composer are
// the same component in both, so the styles live in one module.
import styles from './Chat.module.css';

export default function ChatPage() {
  const { peerId } = useParams();  // MongoDB _id of the person we're chatting with
  const navigate = useNavigate();
  const { dbUser, socket, authFetch } = useAuth();

  // State
  const [messages, setMessages] = useState([]);
  const [peer, setPeer] = useState(null);  // The other user's info
  const [newMessage, setNewMessage] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [loading, setLoading] = useState(true);

  // Refs
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  /**
   * Scroll to bottom of messages
   */
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll when messages change, and when the peer starts typing — the
  // indicator adds height at the bottom and would otherwise sit off-screen.
  useEffect(() => {
    scrollToBottom();
  }, [messages, peerTyping]);

  /**
   * Effect: Fetch peer info and message history
   */
  useEffect(() => {
    const fetchData = async () => {
      if (!dbUser) return;

      try {
        // Fetch peer info
        const peerRes = await authFetch(`/api/user/${peerId}`);
        if (peerRes.ok) {
          const peerData = await peerRes.json();
          setPeer(peerData);
        }

        // Fetch message history
        const msgRes = await authFetch(
          `/api/messages/${dbUser._id}/${peerId}`
        );
        if (msgRes.ok) {
          const msgData = await msgRes.json();
          setMessages(msgData);
        }
      } catch (err) {
        console.error('Error fetching chat data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [dbUser, peerId, authFetch]);

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

    // Emit message via Socket.IO.
    // No senderId — the server knows who this socket is.
    socket.emit('send-message', {
      receiverId: peerId,
      text: newMessage.trim()
    });

    // Clear input
    setNewMessage('');

    // Stop typing indicator
    socket.emit('stop-typing', { receiverId: peerId });
  };

  /**
   * Handle typing in input field
   */
  const handleInputChange = (e) => {
    setNewMessage(e.target.value);

    if (!socket || !dbUser) return;

    // Send typing indicator
    socket.emit('typing', { receiverId: peerId });

    // Clear previous timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop typing indicator after 2 seconds of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop-typing', { receiverId: peerId });
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

  if (loading) {
    return <PageLoader label="Loading conversation" />;
  }

  return (
    <AppShell
      variant="flush"
      backTo="/users"
      title={peer?.displayName || 'Chat'}
      subtitle={peerTyping ? 'typing…' : undefined}
      leading={
        <Avatar
          src={peer?.photoURL}
          name={peer?.displayName}
          size="sm"
          presence={peer?.isOnline}
        />
      }
      actions={
        /* The role badge and the way through to the profile. The name lives
           in the bar's own title, so it is not repeated here — the quickest
           way to check a mentor's expertise mid-conversation is still one
           click away. */
        <>
          <RoleBadge role={peer?.role} />
          <Button size="sm" variant="ghost" onClick={() => navigate(`/users/${peerId}`)}>
            View profile
          </Button>
        </>
      }
    >
      <div className={styles.chat}>
        {/* Transcript */}
        <div className={styles.transcript}>
          {messages.length === 0 ? (
            <div className={styles.emptyChat}>
              <p className={styles.emptyTitle}>No messages yet</p>
              <p className={styles.emptyHint}>
                Say hello to {peer?.displayName?.split(' ')[0] || 'them'}.
              </p>
            </div>
          ) : (
            messages.map((msg, index) => {
              const isMine = msg.sender._id === dbUser._id || msg.sender === dbUser._id;

              return (
                <div
                  key={msg._id || index}
                  className={[styles.row, isMine ? styles.rowMine : styles.rowTheirs].join(' ')}
                >
                  <div
                    className={[styles.bubble, isMine ? styles.mine : styles.theirs].join(' ')}
                  >
                    <span className={styles.text}>{msg.text}</span>
                    <span className={styles.meta}>
                      <time>{formatTime(msg.timestamp)}</time>
                      {/* Read receipt on our own messages only */}
                      {isMine && (
                        <span className={styles.receipt}>
                          {msg.read ? 'Seen' : 'Sent'}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })
          )}

          {/* Typing indicator */}
          {peerTyping && (
            <div className={[styles.row, styles.rowTheirs].join(' ')}>
              <div className={[styles.bubble, styles.theirs, styles.typingBubble].join(' ')}>
                <span className={styles.dots} aria-label="typing">
                  <span className={styles.dot} />
                  <span className={styles.dot} />
                  <span className={styles.dot} />
                </span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <form onSubmit={sendMessage} className={styles.composer}>
          <input
            type="text"
            value={newMessage}
            onChange={handleInputChange}
            placeholder="Write a message…"
            className={styles.input}
            aria-label="Message"
          />
          <button
            type="submit"
            className={styles.send}
            disabled={!newMessage.trim()}
            aria-label="Send message"
          >
            <SendIcon size={17} />
          </button>
        </form>
      </div>
    </AppShell>
  );
}
