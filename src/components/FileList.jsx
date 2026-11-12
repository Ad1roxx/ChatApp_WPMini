/**
 * FileList — the files on a hand-in, or on an assignment's brief
 *
 * The name opens what can be opened — an image, a PDF, anything textual — and
 * downloads the rest, so a click never does nothing and never surprises.
 * Download is its own button beside it, because a file you can preview is
 * still a file you may want to keep. `onRemove` adds the third, which only
 * whoever may change the files gets, and only while they can still change.
 * `renderExtra(file)` is an optional slot after the size (the brief's rubric
 * badge and buttons); hand-ins leave it out.
 */

import { CloseIcon, DownloadIcon, PaperclipIcon } from './Icons';
import { formatBytes, previewKind } from '../lib/attachments';
import styles from './FileList.module.css';

export default function FileList({ files, onOpen, onDownload, onRemove, renderExtra, busy }) {
  return (
    <ul className={styles.files}>
      {files.map((f) => (
        <li key={f.fileId} className={styles.file}>
          <PaperclipIcon size={14} className={styles.fileIcon} />
          <button
            type="button"
            className={styles.fileName}
            onClick={() => onOpen(f)}
            title={previewKind(f.name) ? `Open ${f.name}` : `Download ${f.name}`}
          >
            {f.name}
          </button>
          <span className={styles.fileSize}>{formatBytes(f.size)}</span>
          {renderExtra && renderExtra(f)}
          <button
            type="button"
            className={styles.fileAction}
            onClick={() => onDownload(f)}
            aria-label={`Download ${f.name}`}
          >
            <DownloadIcon size={14} />
          </button>
          {onRemove && (
            <button
              type="button"
              className={styles.fileRemove}
              onClick={() => onRemove(f)}
              disabled={busy}
              aria-label={`Remove ${f.name}`}
            >
              <CloseIcon size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
