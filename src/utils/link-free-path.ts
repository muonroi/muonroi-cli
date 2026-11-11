import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * True when `target` is reached from `anchor` without following a link: no
 * path component strictly below `anchor`, nor `target` itself, is a symlink or
 * junction.
 *
 * Links ABOVE the anchor are deliberately not judged. The old pattern
 * `realpath(p) !== resolve(p)` refused a path when ANY ancestor was a link, so
 * every project under a linked location was refused — macOS `os.tmpdir()`
 * (`/var/folders/...` -> `/private/var/folders/...`) and Windows 8.3 short
 * names (`C:\Users\RUNNER~1\...`, which the native realpath expands) both
 * tripped it on CI. The anchor must be a directory the caller already trusts
 * (it read its own host record through it), so following a link above it
 * grants nothing new; everything the host creates below it stays link-free.
 *
 * Both sides use the native realpath so short names and casing are normalized
 * identically. A missing path throws (ENOENT) — callers treat that as refusal.
 */
export function isLinkFreeBelow(anchor: string, target: string): boolean {
  const lexicalAnchor = path.resolve(anchor);
  const rel = path.relative(lexicalAnchor, path.resolve(target));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return realpathSync.native(target) === path.join(realpathSync.native(lexicalAnchor), rel);
}
