/**
 * Field / Input / Textarea
 *
 * `Field` owns the label, hint, error and character counter; `Input` and
 * `Textarea` are the bare controls. They're used together:
 *
 *   <Field label="Bio" hint="Shown on your profile" count={bio.length} max={500}>
 *     <Textarea value={bio} onChange={...} maxLength={500} />
 *   </Field>
 *
 * `Field` generates an id with `useId` and clones it onto the child, so the
 * label is properly associated without every caller inventing unique ids.
 * That's what makes clicking the label focus the input, and what lets a
 * screen reader announce the field.
 *
 * When `error` is set it's wired through `aria-describedby` and
 * `aria-invalid`, so the message is announced rather than just being red.
 */

import { cloneElement, useId } from 'react';
import styles from './Field.module.css';

export function Field({ label, hint, error, count, max, children, className = '' }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const control = cloneElement(children, {
    id,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': error ? true : undefined,
    'data-invalid': error ? '' : undefined
  });

  const showCounter = typeof count === 'number' && typeof max === 'number';

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      {label && (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      )}

      {control}

      {(hint || error || showCounter) && (
        <div className={styles.footer}>
          <span className={styles.messages}>
            {error ? (
              <span id={errorId} className={styles.error} role="alert">
                {error}
              </span>
            ) : (
              hint && (
                <span id={hintId} className={styles.hint}>
                  {hint}
                </span>
              )
            )}
          </span>

          {showCounter && (
            <span
              className={[
                styles.counter,
                // Warn as they approach the cap rather than only at it
                count > max * 0.9 ? styles.counterNear : ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {count}/{max}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function Input({ className = '', ...rest }) {
  return <input className={[styles.control, className].filter(Boolean).join(' ')} {...rest} />;
}

export function Textarea({ className = '', rows = 4, ...rest }) {
  return (
    <textarea
      rows={rows}
      className={[styles.control, styles.textarea, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
