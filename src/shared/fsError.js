/**
 * One sentence for a path this program could not read.
 *
 * Node's message for a directory is "EISDIR: illegal operation on a directory,
 * read" and for a missing file "ENOENT: no such file or directory, open '…'" —
 * neither is a sentence, and an unhandled rejection adds a stack trace under it.
 * The CLI (issue 325) and the window's project open (issue 323) both say it this
 * way, so the same mistake reads the same on either surface.
 */
export function fileReadReason(error) {
  switch (error?.code) {
    case 'EISDIR': return 'is a directory';
    case 'ENOENT': return 'not found';
    case 'EACCES':
    case 'EPERM': return 'permission denied';
    case 'ENOTDIR': return 'a path component is not a directory';
    case 'ELOOP': return 'too many symbolic links';
    case 'ENOSPC': return 'no space left on the device';
    default: return error?.message || 'unknown error';
  }
}

/** `cannot read <path>: <reason>` — the CLI's shape, and the window's. */
export function readFailure(file, error) {
  return `cannot read ${file}: ${fileReadReason(error)}`;
}

/**
 * Why a project file was refused, as one line, naming the file.
 *
 * Issue 323: the reason has to be the validator's own first error. A stand-in
 * from another code path ("A project needs at least one flow." for a 10,002-node
 * file that has one flow) sends the reader to fix the wrong thing.
 */
export function openFailureMessage(file, { errors = [], error = null } = {}) {
  if (error) return readFailure(file, error);
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const detail = first.path ? `${first.path}: ${first.message}` : String(first.message || 'invalid');
    const extra = errors.length - 1;
    return `${file}: ${detail}${extra > 0 ? ` · +${extra} more` : ''}`;
  }
  return `${file}: invalid project.`;
}
