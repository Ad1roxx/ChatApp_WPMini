/**
 * AssignmentFiles — the files attached to an assignment's brief
 *
 * Everyone it is shown to can list, open and download them. Only the mentor
 * who set the assignment (`canEdit`) can add and remove; the server enforces
 * that, this only decides which buttons to draw.
 *
 * Limits are shown as the server reports them: the picker's own checks are the
 * same two the hand-in uses (count and size), and any other refusal is the
 * server's own words in a toast.
 *
 * The mentor can mark one file as the rubric. It is mentor-only until they
 * share it. The server enforces who sees it (`reads.assignmentFilesFor`, and
 * the search index); here a badge says which state it is in, and the buttons
 * only appear when `canEdit`.
 *
 * Refresh: the server announces `assignment-changed` (with the id) to the
 * mentor and every student whenever a brief or its files change, and this list
 * refetches on it, the same way the brief itself does. `initial` is what the
 * page already holds (a student's work carries `assignment.attachments`), shown
 * until the first refetch.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Button from './Button';
import FileList from './FileList';
import FilePreview from './FilePreview';
import { useToast } from './Toast';
import {
  ACCEPT,
  MAX_FILE_BYTES,
  MAX_FILES,
  formatBytes,
  pickProblem,
  previewKind,
  rubricActions,
  rubricBadge,
  saveBlob,
  uploadBriefFiles
} from '../lib/attachments';
import styles from './AssignmentFiles.module.css';

export default function AssignmentFiles({ assignmentId, initial = [], canEdit = false }) {
  const { authFetch, socket } = useAuth();
  const toast = useToast();
  const fileInput = useRef(null);

  // null until a refetch (or an upload/removal) has told us better than `initial`.
  const [fetched, setFetched] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState(null); // fileId with a rubric request in flight
  const [previewing, setPreviewing] = useState(null);

  const files = fetched ?? initial;
  const base = `/api/assignments/${assignmentId}/files`;

  useEffect(() => {
    if (!socket) return undefined;
    let stale = false;

    const handle = async (payload) => {
      if (payload?.assignmentId && String(payload.assignmentId) !== String(assignmentId)) return;
      try {
        const res = await authFetch(`/api/assignments/${assignmentId}/files`);
        if (res.ok && !stale) setFetched((await res.json()).attachments);
      } catch (err) {
        console.error('Error refreshing assignment files:', err);
      }
    };

    socket.on('assignment-changed', handle);
    return () => {
      stale = true;
      socket.off('assignment-changed', handle);
    };
  }, [socket, authFetch, assignmentId]);

  const attach = async (picked) => {
    const problem = pickProblem(files.length, picked, 'assignment');
    if (problem) {
      toast.error(problem);
      return;
    }
    if (picked.length === 0) return;

    setBusy(true);
    const { attachments, errors } = await uploadBriefFiles(authFetch, assignmentId, picked);
    setBusy(false);

    if (attachments) setFetched(attachments);
    errors.forEach((message) => toast.error(message));
    const sent = picked.length - errors.length;
    if (sent > 0) toast.success(sent === 1 ? 'File attached' : `${sent} files attached`);
  };

  const detach = async (f) => {
    setBusy(true);
    try {
      const res = await authFetch(`${base}/${f.fileId}`, { method: 'DELETE' });
      if (res.ok) {
        setFetched((await res.json()).attachments);
        toast.success(`Removed ${f.name}`);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not remove that file');
      }
    } catch (err) {
      console.error('Error removing assignment file:', err);
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const patchRubric = async (f, body) => {
    setRowBusy(f.fileId);
    try {
      const res = await authFetch(`${base}/${f.fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        setFetched((await res.json()).attachments);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not change that file');
      }
    } catch (err) {
      console.error('Error changing assignment file:', err);
      toast.error('Could not reach the server');
    } finally {
      setRowBusy(null);
    }
  };

  const rubricExtra = (f) => {
    const badge = rubricBadge(f);
    const { rubric, share } = rubricActions(f, canEdit);
    if (!badge && !rubric) return null;
    const disabled = busy || rowBusy === f.fileId;
    return (
      <span className={styles.rubric}>
        {badge && <span className={styles.badge}>{badge}</span>}
        {[rubric, share].map(
          (action) =>
            action && (
              <button
                key={action.label}
                type="button"
                className={styles.rubricButton}
                disabled={disabled}
                onClick={() => patchRubric(f, action.body)}
              >
                {action.label}
              </button>
            )
        )}
      </span>
    );
  };

  // Download through authFetch: the route needs the sign-in token, which a
  // plain link cannot send (see SubmissionRow).
  const download = async (f) => {
    try {
      const res = await authFetch(`${base}/${f.fileId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not download that file');
        return;
      }
      saveBlob(await res.blob(), f.name);
    } catch (err) {
      console.error('Error downloading assignment file:', err);
      toast.error('Could not reach the server');
    }
  };

  const open = (f) => (previewKind(f.name) ? setPreviewing(f) : download(f));

  if (files.length === 0 && !canEdit) return null;

  return (
    <div className={styles.files}>
      <span className={styles.label}>Files</span>

      {files.length > 0 ? (
        <FileList
          files={files}
          onOpen={open}
          onDownload={download}
          onRemove={canEdit ? detach : undefined}
          renderExtra={rubricExtra}
          busy={busy}
        />
      ) : (
        <p className={styles.hint}>No files attached.</p>
      )}

      {canEdit && (
        <div className={styles.row}>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const picked = [...e.target.files];
              e.target.value = '';
              attach(picked);
            }}
          />
          <Button
            size="sm"
            loading={busy}
            disabled={busy || files.length >= MAX_FILES}
            onClick={() => fileInput.current?.click()}
          >
            Attach files
          </Button>
          <span className={styles.hint}>
            Up to {MAX_FILES}, {formatBytes(MAX_FILE_BYTES)} each. Students it was set for can
            open them.
          </span>
        </div>
      )}

      <FilePreview
        file={previewing}
        path={previewing ? `${base}/${previewing.fileId}` : ''}
        onClose={() => setPreviewing(null)}
      />
    </div>
  );
}
