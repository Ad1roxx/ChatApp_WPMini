/**
 * ConfirmDialog — replaces `window.confirm()`.
 *
 * Same reasoning as toasts replacing `alert()`: the browser dialog can't be
 * styled, blocks the page, and announces the origin ("localhost:5173 says").
 *
 * Built on the native `<dialog>` element rather than a div overlay, which
 * gives three things for free that a hand-rolled modal usually gets wrong:
 * focus is trapped inside while it's open, Escape closes it, and the content
 * behind it is inert. The `::backdrop` pseudo-element is the scrim.
 *
 * `showModal()` throws if called on an already-open dialog, hence the
 * `open` check before calling it.
 */

import { useEffect, useRef } from 'react';
import Button from './Button';
import styles from './ConfirmDialog.module.css';

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Escape fires the dialog's `cancel` event rather than a click, so the
  // parent's state has to be told separately or it would reopen instantly.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleCancel = (e) => {
      e.preventDefault();
      onCancel?.();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onCancel]);

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby="confirm-title">
      <h2 id="confirm-title" className={styles.title}>
        {title}
      </h2>
      {description && <p className={styles.description}>{description}</p>}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
