/**
 * Telling someone their message was not sent.
 *
 * The server limits how fast one account may send messages (server/lib/rateLimit.js)
 * and answers a message over the limit on the socket's `error` event, with
 * `tooFast: true` and the `text` it refused. The chat pages did not listen for
 * it, so the message simply never appeared, with the box already cleared. They
 * now show this notice and put that text back in the box.
 *
 * The text comes from the server's answer, not from what the page last sent:
 * several messages can be on their way at once, and the one refused need not be
 * the last. If the box already holds something, it is left alone; the notice
 * still says a message was not sent.
 */
import { useEffect, useState } from 'react';

/** How long the notice stays, in milliseconds. */
export const NOT_SENT_MS = 8000;

export const NOT_SENT_TEXT =
  'Message not sent: you are sending messages too quickly. Wait a few seconds, then send it again.';

/** The notice for a socket error, or null when the error is not a refused message. */
export function notSentNotice(err) {
  return err && err.tooFast === true ? NOT_SENT_TEXT : null;
}

/** The text the server refused, from its answer; '' when it did not say. */
export function refusedText(err) {
  return err && typeof err.text === 'string' ? err.text : '';
}

/** What the box should hold after a refusal: what was typed since, or else the text that was not sent. */
export function restoredText(current, refused) {
  return current || refused || '';
}

/**
 * The notice for this socket, or null. `onRefused(text)` is called with the
 * refused text when a message is refused, so the page can put it back; it must
 * be stable (useCallback).
 */
export function useNotSent(socket, onRefused) {
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!socket) return undefined;
    const onError = (err) => {
      const text = notSentNotice(err);
      if (!text) return;
      setNotice(text);
      if (onRefused) onRefused(refusedText(err));
    };
    socket.on('error', onError);
    return () => socket.off('error', onError);
  }, [socket, onRefused]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOT_SENT_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return notice;
}
