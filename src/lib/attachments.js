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

/** For `<input type="file" accept>`. */
export const ACCEPT = EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** 2048 → "2 KB". Whole units below a megabyte; one decimal above, dropped when .0. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Number((n / (1024 * 1024)).toFixed(1))} MB`;
}
