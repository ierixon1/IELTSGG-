import { rmSync } from 'node:fs';

/**
 * Removes a suite's scratch directory, and does not fail the run if it cannot.
 *
 * On Windows a directory that a process has just finished writing to is often
 * still held briefly — by the filesystem filter driver, an indexer, or a
 * scanner — and `rm` answers EPERM. Retrying covers most of it, but not all,
 * and a suite whose every assertion passed should not be reported as failing
 * because the operating system was slow to let go of a temp folder. What is
 * left behind is under the OS temp directory, which the OS reclaims.
 */
export function removeTempRoot(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Deliberately ignored: see above.
  }
}
