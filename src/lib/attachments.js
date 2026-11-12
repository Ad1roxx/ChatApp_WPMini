/**
 * What the server accepts as an attachment, mirrored for the file picker.
 *
 * The server's list (server/lib/fileStore.js) is the one that is enforced;
 * this copy only stops the picker offering files that would be refused. If
 * the two ever disagree, the server wins and says why.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;

const EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip',
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
  'rb', 'php', 'kt', 'swift', 'sql', 'json', 'ipynb', 'html', 'css', 'xml',
  'yaml', 'yml'
];

/**
 * What a browser can show without anything converting it first.
 *
 * Word, Excel, PowerPoint and their OpenDocument equivalents are missing on
 * purpose: rendering them means converting them, which means a service.
 * Classroom previews them because Drive does that conversion; here they stay
 * download-only, and the row never offers a preview it cannot give.
 */
const PREVIEWABLE = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  pdf: ['pdf'],
  text: [
    'txt', 'md', 'csv',
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
    'rb', 'php', 'kt', 'swift', 'sql', 'json', 'ipynb', 'html', 'css', 'xml',
    'yaml', 'yml'
  ]
};

/** 'image' | 'pdf' | 'text', or null when it can only be downloaded. */
export function previewKind(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const found = Object.entries(PREVIEWABLE).find(([, list]) => list.includes(ext));
  return found ? found[0] : null;
}

/**
 * How much of a text file to read into the preview. Beyond this it is not
 * reading, it is scrolling — and a 10 MB file of source would be laid out as
 * one very long line of DOM.
 */
export const PREVIEW_TEXT_LIMIT = 256 * 1024;

/** For `<input type="file" accept>`. */
export const ACCEPT = EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** 2048 → "2 KB". Whole units below a megabyte; one decimal above, dropped when .0. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Number((n / (1024 * 1024)).toFixed(1))} MB`;
}

/**
 * Why a chosen set of files should not be sent, or null when it is fine.
 *
 * Only the two limits the picker can know before asking: how many there will
 * be, and how big each one is. Whether a TYPE is allowed is left to the server
 * (the picker's `accept` already steers), and so is anything else it reports.
 * `noun` completes "Up to 5 files per ___".
 */
export function pickProblem(existingCount, picked, noun) {
  if (picked.length === 0) return null;

  if (existingCount + picked.length > MAX_FILES) {
    return `Up to ${MAX_FILES} files per ${noun}`;
  }

  const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
  if (tooBig) return `${tooBig.name} is over ${formatBytes(MAX_FILE_BYTES)}`;

  return null;
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Freed a minute later, long after the browser has taken the bytes.
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

/**
 * Upload files to an assignment's brief, one at a time, and say what went wrong
 * for each one that did not go. A refusal does not stop the rest: the server
 * judges every file on its own (type, size, the limit of five), and the person
 * should hear about all of them at once rather than fix and retry one by one.
 *
 * `authFetch` is the signed-in fetch. Resolves to `{ attachments, errors }`:
 * the brief's files as the server last reported them (null if none went up),
 * and one `"name: reason"` line per refusal.
 */
export async function uploadBriefFiles(authFetch, assignmentId, files) {
  let attachments = null;
  const errors = [];

  for (const file of files) {
    try {
      const form = new FormData();
      form.append('file', file);

      const res = await authFetch(`/api/assignments/${assignmentId}/files`, {
        method: 'POST',
        body: form
      });

      if (res.ok) {
        attachments = (await res.json()).attachments;
      } else {
        const err = await res.json().catch(() => ({}));
        errors.push(`${file.name}: ${err.error || 'could not be attached'}`);
      }
    } catch {
      errors.push(`${file.name}: could not reach the server`);
    }
  }

  return { attachments, errors };
}

/**
 * The rubric badge for a brief file, or null when it is not the rubric.
 * Read-only: shown to anyone who is given the file (the server decides who
 * receives an unshared rubric, so a student only ever sees "shared").
 */
export function rubricBadge(file) {
  const r = file?.rubric;
  if (!r?.isRubric) return null;
  return r.shared ? 'Rubric · shared with students' : 'Rubric · mentor only';
}

/**
 * The rubric buttons to draw on a brief file for the mentor who set it:
 * `{ rubric, share }`, each a `{ label, body }` (body is the PATCH payload),
 * or null when not offered. Nobody else gets any buttons. Sharing is only
 * offered on the file that is the rubric.
 */
export function rubricActions(file, canEdit) {
  if (!canEdit) return { rubric: null, share: null };
  const isRubric = Boolean(file?.rubric?.isRubric);
  const shared = Boolean(file?.rubric?.shared);
  return {
    rubric: isRubric
      ? { label: 'Unmark rubric', body: { rubric: false } }
      : { label: 'Mark as rubric', body: { rubric: true } },
    share: isRubric
      ? shared
        ? { label: 'Stop sharing', body: { shared: false } }
        : { label: 'Share with students', body: { shared: true } }
      : null
  };
}
