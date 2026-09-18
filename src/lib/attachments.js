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
