/* eslint-disable react-refresh/only-export-components --
 * Provider and hook in one file, for the same reason AuthContext does it:
 * that is the standard React context pattern, and splitting the hook out
 * purely to satisfy Fast Refresh would scatter one coherent piece of the app
 * across two modules. The cost is a full reload when this file is edited.
 */

/**
 * ConversationsContext — who said what last, and how much you have not read
 *
 * Two screens need this and they must agree: the messages list draws a
 * preview and a count per person, and the sidebar draws one total beside
 * "Messages". If each fetched and tracked its own copy they would drift the
 * moment a socket event arrived while only one of them was mounted.
 *
 * So the state lives here, above both, and the socket wiring exists once.
 *
 * Groups ride along in the same context for the same reason: the Groups list
 * and the sidebar badge beside it need the same numbers, and a second provider
 * would have meant a second socket subscription racing the first.
 *
 * ## What keeps it current
 *
 * - `new-message`   someone messaged you → bump their count, replace the preview
 * - `message-sent`  you messaged someone → replace the preview, count untouched
 * - `conversation-read`  you opened a chat → that count goes to zero
 * - `group-activity`  anything said in a group you are in → same, per group
 * - `group-read`  you opened a group → that count goes to zero
 *
 * `group-activity` is unicast to every member rather than broadcast to the
 * group's room, because the room only holds people who currently have the
 * group *open* — and everyone else is precisely who a badge is for.
 *
 * The last one is emitted to your *own* tabs by the server when it processes
 * `mark-read`. It is what makes the badge clear in the window you left open
 * on the list while reading in another.
 *
 * A message arriving in the chat you are already looking at briefly increments
 * the count before ChatPage's `mark-read` round-trips and clears it again.
 * That is a frame or two of a "1" on a conversation you are reading, and it
 * self-corrects; the alternative is this context tracking which route is open,
 * which is a great deal of coupling to avoid a flicker nobody has reported.
 */

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext';

const ConversationsContext = createContext(null);

/** Everything the UI needs about one peer, in the shape the server sends. */
const emptyRow = { lastText: '', lastAt: null, lastFromMe: false, unread: 0 };

export function ConversationsProvider({ children }) {
  const { dbUser, socket, authFetch } = useAuth();

  // { [peerId]: { lastText, lastAt, lastFromMe, unread } }
  const [byPeer, setByPeer] = useState({});
  // { [groupId]: { lastText, lastAt, lastFromMe, lastSenderName, unread } }
  const [byGroup, setByGroup] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!dbUser) return undefined;

    let stale = false;

    const load = async () => {
      try {
        const [dmRes, groupRes] = await Promise.all([
          authFetch('/api/conversations'),
          authFetch('/api/groups/conversations')
        ]);

        if (dmRes.ok && !stale) {
          const rows = await dmRes.json();
          setByPeer(
            Object.fromEntries(
              rows.map((r) => [
                r.peerId,
                {
                  lastText: r.lastText,
                  lastAt: r.lastAt,
                  lastFromMe: r.lastFromMe,
                  unread: r.unread
                }
              ])
            )
          );
        }

        if (groupRes.ok && !stale) {
          const rows = await groupRes.json();
          setByGroup(
            Object.fromEntries(
              rows.map((r) => [
                r.groupId,
                {
                  lastText: r.lastText,
                  lastAt: r.lastAt,
                  lastFromMe: r.lastFromMe,
                  lastSenderName: r.lastSenderName,
                  unread: r.unread
                }
              ])
            )
          );
        }
      } catch (err) {
        console.error('Error loading conversations:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    return () => {
      stale = true;
    };
  }, [dbUser, authFetch]);

  useEffect(() => {
    if (!socket || !dbUser) return undefined;

    const me = dbUser._id;
    const idOf = (v) => (v && v._id ? v._id : v);

    /** Someone messaged you. */
    const handleIncoming = (message) => {
      const peer = idOf(message.sender);
      if (peer === me) return;

      setByPeer((prev) => {
        const row = prev[peer] || emptyRow;
        return {
          ...prev,
          [peer]: {
            lastText: message.text,
            lastAt: message.timestamp,
            lastFromMe: false,
            unread: row.unread + 1
          }
        };
      });
    };

    /** You messaged someone — from this tab or another one. */
    const handleOutgoing = (message) => {
      const peer = idOf(message.receiver);

      setByPeer((prev) => {
        const row = prev[peer] || emptyRow;
        return {
          ...prev,
          [peer]: {
            ...row,
            lastText: message.text,
            lastAt: message.timestamp,
            lastFromMe: true
          }
        };
      });
    };

    /** You read a conversation, here or in another tab. */
    const handleRead = ({ peerId }) => {
      setByPeer((prev) => {
        const row = prev[peerId];
        if (!row || row.unread === 0) return prev;
        return { ...prev, [peerId]: { ...row, unread: 0 } };
      });
    };

    /**
     * Anything said in a group you belong to — including by you.
     *
     * Your own message updates the preview but never the count, which is the
     * same rule the direct-message pair follows, just arriving on one event
     * instead of two: a group broadcast cannot know per-recipient whether it
     * is incoming or outgoing, so the comparison happens here.
     */
    const handleGroupActivity = (a) => {
      const fromMe = String(a.senderId) === String(me);

      setByGroup((prev) => {
        const row = prev[a.groupId] || { unread: 0 };
        return {
          ...prev,
          [a.groupId]: {
            lastText: a.text,
            lastAt: a.timestamp,
            lastFromMe: fromMe,
            lastSenderName: a.senderName,
            unread: fromMe ? row.unread : (row.unread || 0) + 1
          }
        };
      });
    };

    /** You opened a group, here or in another tab. */
    const handleGroupRead = ({ groupId }) => {
      setByGroup((prev) => {
        const row = prev[groupId];
        if (!row || row.unread === 0) return prev;
        return { ...prev, [groupId]: { ...row, unread: 0 } };
      });
    };

    socket.on('new-message', handleIncoming);
    socket.on('message-sent', handleOutgoing);
    socket.on('conversation-read', handleRead);
    socket.on('group-activity', handleGroupActivity);
    socket.on('group-read', handleGroupRead);

    return () => {
      socket.off('new-message', handleIncoming);
      socket.off('message-sent', handleOutgoing);
      socket.off('conversation-read', handleRead);
      socket.off('group-activity', handleGroupActivity);
      socket.off('group-read', handleGroupRead);
    };
  }, [socket, dbUser]);

  /**
   * Clear a count without waiting for the server.
   *
   * ChatPage already emits `mark-read` on open, so the socket will confirm
   * this in a moment. Doing it locally first means the badge disappears as
   * the chat opens rather than a round-trip later.
   */
  const markRead = useCallback((peerId) => {
    setByPeer((prev) => {
      const row = prev[peerId];
      if (!row || row.unread === 0) return prev;
      return { ...prev, [peerId]: { ...row, unread: 0 } };
    });
  }, []);

  /** The same, for a group. GroupChatPage emits `mark-group-read` on open. */
  const markGroupRead = useCallback((groupId) => {
    setByGroup((prev) => {
      const row = prev[groupId];
      if (!row || row.unread === 0) return prev;
      return { ...prev, [groupId]: { ...row, unread: 0 } };
    });
  }, []);

  const totalUnread = useMemo(
    () => Object.values(byPeer).reduce((n, row) => n + row.unread, 0),
    [byPeer]
  );

  const totalGroupUnread = useMemo(
    () => Object.values(byGroup).reduce((n, row) => n + (row.unread || 0), 0),
    [byGroup]
  );

  const value = useMemo(
    () => ({
      byPeer,
      byGroup,
      totalUnread,
      totalGroupUnread,
      loading,
      markRead,
      markGroupRead
    }),
    [byPeer, byGroup, totalUnread, totalGroupUnread, loading, markRead, markGroupRead]
  );

  return (
    <ConversationsContext.Provider value={value}>
      {children}
    </ConversationsContext.Provider>
  );
}

/**
 * Safe outside the provider: the login and role-picker screens render before
 * it mounts, and a sidebar badge is not worth a crash.
 */
export function useConversations() {
  return (
    useContext(ConversationsContext) || {
      byPeer: {},
      byGroup: {},
      totalUnread: 0,
      totalGroupUnread: 0,
      loading: false,
      markRead: () => {},
      markGroupRead: () => {}
    }
  );
}
