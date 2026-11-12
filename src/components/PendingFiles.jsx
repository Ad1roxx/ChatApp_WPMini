/**
 * PendingFiles — choose files for a brief that does not exist yet
 *
 * Nothing is uploaded here: an assignment has no id until it is created, so
 * the chosen files wait in the parent's state and go up afterwards, one by one
 * (`uploadBriefFiles`). The same two checks as everywhere files are picked
 * (count and size); everything else the server decides and reports.
 */

import { useRef } from 'react';
import Button from './Button';
import { useToast } from './Toast';
import { CloseIcon, PaperclipIcon } from './Icons';
import {
  ACCEPT,
  MAX_FILE_BYTES,
  MAX_FILES,
  formatBytes,
  pickProblem
} from '../lib/attachments';
import fileStyles from './FileList.module.css';
import styles from './AssignmentFiles.module.css';

export default function PendingFiles({ files, onChange, disabled }) {
  const toast = useToast();
  const input = useRef(null);

  const add = (picked) => {
    const problem = pickProblem(files.length, picked, 'assignment');
    if (problem) {
      toast.error(problem);
      return;
    }
    onChange([...files, ...picked]);
  };

  return (
    <div className={styles.files}>
      <span className={styles.label}>Files</span>

      {files.length > 0 && (
        <ul className={fileStyles.files}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className={fileStyles.file}>
              <PaperclipIcon size={14} className={fileStyles.fileIcon} />
              <span className={styles.pickedItem}>{f.name}</span>
              <span className={fileStyles.fileSize}>{formatBytes(f.size)}</span>
              <button
                type="button"
                className={fileStyles.fileRemove}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                disabled={disabled}
                aria-label={`Do not attach ${f.name}`}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.row}>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const picked = [...e.target.files];
            e.target.value = '';
            add(picked);
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={disabled || files.length >= MAX_FILES}
          onClick={() => input.current?.click()}
        >
          Choose files
        </Button>
        <span className={styles.hint}>
          Optional. Up to {MAX_FILES}, {formatBytes(MAX_FILE_BYTES)} each. They are attached
          once the assignment is set.
        </span>
      </div>
    </div>
  );
}
