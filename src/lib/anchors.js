/**
 * Going to a record's row: on this page, or on another page by its URL's hash.
 *
 * The assistant's citations lead to rows carrying `id="source-<kind>-<id>"`.
 * The rows of a mentorship's page load in their own components, after the page
 * itself, so a hash is followed by watching for its element to appear, for a few
 * seconds, rather than looking once.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Only the anchors our own rows carry: nothing else in a URL is looked up. */
export const ANCHOR = /^source-(goal|submission|assignment|resource|session)-[0-9a-f]{24}$/;

/** Scroll to the element and move focus to it, so the keyboard follows. False if it isn't there. */
export function scrollToAnchor(id, doc = document) {
  const el = doc.getElementById(id);
  if (!el) return false;
  el.setAttribute('tabindex', '-1');
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
  return true;
}

/** Follow `#source-…` in the URL once its row exists, giving up after `waitMs`. */
export function useScrollToHash(ready, waitMs = 5000) {
  const { hash } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!ready || !ANCHOR.test(id)) return undefined;
    if (scrollToAnchor(id)) return undefined;
    const observer = new MutationObserver(() => {
      if (scrollToAnchor(id)) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), waitMs);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [hash, ready, waitMs]);
}
