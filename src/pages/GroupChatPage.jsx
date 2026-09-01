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
 *
 * Shares Chat.module.css with ChatPage — the transcript, bubbles and
 * composer are the same thing in both. Only the sender labels above
 * incoming messages and the multi-person typing line are group-specific.
 */

import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import Avatar from '../components/Avatar';
import { PageLoader } from '../components/Loading';
import { SendIcon } from '../components/Icons';
import styles from './Chat.module.css';
import groupStyles from './GroupChatPage.module.css';

export default function GroupChatPage() {
  const { groupId } = useParams();
  const { dbUser, socket, authFetch } = useAuth();

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
        const groupsRes = await authFetch(
          `/api/groups?userId=${dbUser._id}`
        );
        if (groupsRes.ok) {
          const myGroups = await groupsRes.json();
          setGroup(myGroups.find((g) => g._id === groupId) || null);
        }

        // Message history
        const msgRes = await authFetch(
          `/api/groups/${groupId}/messages`
        );
        if (msgRes.ok) setMessages(await msgRes.json());
      } catch (err) {
        console.error('Error fetching group chat data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [dbUser, groupId, authFetch]);

  /**
   * Look up a member's display name from the loaded group.
   *
   * Declared ABOVE the effect below, which calls it from its typing handler.
   * It used to sit after that effect, which worked — the handler only runs on
   * socket events, long after render — but it reads as a use-before-declare
   * and the linter flags it as one. Ordering it properly costs nothing.
   */
  const memberName = (userId) => {
    const m = group?.members?.find((mem) => (mem._id || mem) === userId);
    return m?.displayName || 'Someone';
  };

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

  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !socket || !dbUser) return;

    // No senderId — the server knows who this socket is.
    socket.emit('send-group-message', {
      groupId,
      text: newMessage.trim()
    });

    setNewMessage('');
    socket.emit('group-stop-typing', { groupId });
  };

  const handleInputChange = (e) => {
    setNewMessage(e.target.value);
    if (!socket || !dbUser) return;

    socket.emit('group-typing', { groupId });

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('group-stop-typing', { groupId });
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
      ? `${typingNames[0]} is typing…`
      : `${typingNames.slice(0, 2).join(', ')}${
          typingNames.length > 2 ? ' and others' : ''
        } are typing…`;

  if (loading) {
    return <PageLoader label="Loading group" />;
  }

  const memberCount = group?.members?.length || 0;

  return (
    <AppShell
      variant="flush"
      backTo="/groups"
      title={group?.name || 'Group'}
      subtitle={typingLabel || `${memberCount} member${memberCount === 1 ? '' : 's'}`}
    >
      <div className={styles.chat}>
        {/* Member strip — who is actually in this conversation */}
        <div className={groupStyles.strip}>
          <span className={groupStyles.groupAvatar} aria-hidden="true">
            {group?.name?.charAt(0)?.toUpperCase() || 'G'}
          </span>
          <span className={groupStyles.stripText}>
            <span className={groupStyles.groupName}>{group?.name || 'Group'}</span>
            <span className={groupStyles.groupMeta}>
              {memberCount} member{memberCount === 1 ? '' : 's'}
            </span>
          </span>

          <span className={groupStyles.members}>
            {group?.members?.slice(0, 5).map((m) => (
              <Avatar
                key={m._id || m}
                src={m.photoURL}
                name={m.displayName}
                size="xs"
                className={groupStyles.memberAvatar}
              />
            ))}
            {memberCount > 5 && (
              <span className={groupStyles.memberOverflow}>+{memberCount - 5}</span>
            )}
          </span>
        </div>

        {/* Transcript */}
        <div className={styles.transcript}>
          {messages.length === 0 ? (
            <div className={styles.emptyChat}>
              <p className={styles.emptyTitle}>No messages yet</p>
              <p className={styles.emptyHint}>Start the conversation.</p>
            </div>
          ) : (
            messages.map((msg, index) => {
              const senderId = msg.sender?._id || msg.sender;
              const isMine = senderId === dbUser._id;

              return (
                <div
                  key={msg._id || index}
                  className={[styles.row, isMine ? styles.rowMine : styles.rowTheirs].join(' ')}
                >
                  <div
                    className={[styles.bubble, isMine ? styles.mine : styles.theirs].join(' ')}
                  >
                    {/* Sender name above incoming messages only — on your own
                        messages it would just repeat who you are. */}
                    {!isMine && (
                      <span className={groupStyles.sender}>
                        {msg.sender?.displayName || 'Unknown'}
                      </span>
                    )}
                    <span className={styles.text}>{msg.text}</span>
                    <span className={styles.meta}>
                      <time>{formatTime(msg.timestamp)}</time>
                    </span>
                  </div>
                </div>
              );
            })
          )}

          {typingLabel && <p className={groupStyles.typingLine}>{typingLabel}</p>}

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
