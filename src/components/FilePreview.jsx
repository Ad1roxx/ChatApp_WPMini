/**
 * FilePreview — look at a hand-in's file without leaving the page
 *
 * Three kinds can be shown, and that is a fact about browsers rather than a
 * decision: an image, plain text (source code included), and a PDF. Word,
 * Excel and PowerPoint cannot be rendered without converting them first, which
 * needs a service — Classroom previews them because Drive does that conversion
 * on its own servers. Those stay download-only, and the list never offers a
 * preview it cannot give.
 *
 * ## Nothing about how files are SERVED changes for this
 *
 * The server still sends every file as a download, with a Content-Type it
 * chose from the extension, `nosniff`, and a CSP sandbox. The preview renders
 * the copy the browser already holds in memory, so an uploaded page still
 * cannot run as a page on this origin — the same reason the download path
 * fetches with the token instead of pointing an <a> at the route.
 *
 * Built on <dialog>, like ConfirmDialog, for the same three free things: focus
 * is trapped inside, Escape closes it, and the page behind it is inert.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Button from './Button';
import { InlineLoader } from './Loading';
import { PREVIEW_TEXT_LIMIT, formatBytes, previewKind } from '../lib/attachments';
import styles from './FilePreview.module.css';

export default function FilePreview({ file, path, page, onClose }) {
  const { authFetch } = useAuth();
  const ref = useRef(null);

  // What has been fetched, and which file it belongs to. Keyed that way so a
  // second file opening reads as "loading" without this effect having to set
  // state on the way in — React's rules object to that, and the check below
  // says the same thing more directly.
  const [loaded, setLoaded] = useState(null);

  const kind = file ? previewKind(file.name) : null;
  const view = loaded && loaded.file === file ? loaded : null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (file && !dialog.open) dialog.showModal();
    else if (!file && dialog.open) dialog.close();
  }, [file]);

  // Escape fires the dialog's `cancel` event rather than a click, so the
  // parent's state has to be told separately or it would reopen instantly.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;

    const handleCancel = (e) => {
      e.preventDefault();
      onClose?.();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  /**
   * Fetched once per file, and the blob is kept: Download below saves the copy
   * already in memory rather than asking the server for it a second time.
   */
  useEffect(() => {
    if (!file) return undefined;

    let stale = false;
    let url = null;

    const load = async () => {
      try {
        const res = await authFetch(path);
        if (!res.ok) {
          if (!stale) setLoaded({ file, error: true });
          return;
        }

        const blob = await res.blob();
        if (stale) return;

        if (kind === 'text') {
          // Only the first slice is read: a 10 MB file of source would
          // otherwise be laid out as one very long line of DOM.
          const text = await blob.slice(0, PREVIEW_TEXT_LIMIT).text();
          if (!stale) {
            setLoaded({ file, blob, text, clipped: blob.size > PREVIEW_TEXT_LIMIT });
          }
          return;
        }

        url = URL.createObjectURL(blob);
        if (!stale) setLoaded({ file, blob, url });
      } catch (err) {
        console.error('Error loading preview:', err);
        if (!stale) setLoaded({ file, error: true });
      }
    };

    load();
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, path, kind, authFetch]);

  const save = () => {
    if (!view?.blob) return;

    const href = URL.createObjectURL(view.blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Freed a minute later, long after the browser has taken the bytes.
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={file ? `Preview of ${file.name}` : 'Preview'}
    >
      <div className={styles.head}>
        <span className={styles.name}>{file?.name}</span>
        {file?.size != null && <span className={styles.size}>{formatBytes(file.size)}</span>}
      </div>

      <div className={styles.body}>
        {!view && <InlineLoader label="Opening the file" />}

        {view?.error && (
          <p className={styles.error}>
            That file could not be opened here. Downloading it should still work.
          </p>
        )}

        {view && !view.error && kind === 'image' && (
          <img src={view.url} alt={file.name} className={styles.image} />
        )}

        {/* The browser's own PDF viewer. It renders the blob this page already
            holds, so nothing is re-fetched and no URL to the file exists. `page`
            is the viewer's own open parameter: one that ignores it opens page 1. */}
        {view && !view.error && kind === 'pdf' && (
          <iframe src={page ? `${view.url}#page=${page}` : view.url} title={file.name} className={styles.frame} />
        )}

        {view && !view.error && kind === 'text' && (
          <>
            <pre className={styles.text}>{view.text}</pre>
            {view.clipped && (
              <p className={styles.clipped}>
                Showing the first {formatBytes(PREVIEW_TEXT_LIMIT)}. Download it to
                read the rest.
              </p>
            )}
          </>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" onClick={save} disabled={!view?.blob}>
          Download
        </Button>
      </div>
    </dialog>
  );
}
