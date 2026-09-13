/**
 * Grants admin or examiner to an account that has already registered — how the
 * first administrator of a Firestore deployment is made (M3), since there is no
 * way to seed one there.
 *
 *   npm run admin:promote -- <username> [admin|examiner]
 *
 * Run it with the deployment's own environment: `STORAGE_BACKEND=gcs_firestore`
 * and its Firestore credentials change that project; `STORAGE_BACKEND=local`
 * changes `data/` in the working directory. The account's sessions end, and the
 * new role applies from its next sign-in. The same promotion can be applied when
 * the server starts, with `ADMIN_PROMOTE_USERNAME` and `ADMIN_PROMOTE_ROLE`.
 *
 * Exit status: 0 promoted or already that role; 1 no such account; 64 bad usage;
 * 78 no storage backend chosen.
 */
import 'dotenv/config';

const [username, role = 'admin'] = process.argv.slice(2);
if (!username || (role !== 'admin' && role !== 'examiner')) {
  console.error('Usage: npm run admin:promote -- <username> [admin|examiner]');
  process.exit(64);
}
if (process.env.STORAGE_BACKEND !== 'local' && process.env.STORAGE_BACKEND !== 'gcs_firestore') {
  console.error('Set STORAGE_BACKEND to the store to change: local or gcs_firestore.');
  process.exit(78);
}

const { authService } = await import('../src/services/authService');
const result = await authService.promoteAccount(username, role);
if (result.outcome === 'not_found') {
  console.error(`No account named "${username.trim().toLowerCase()}" exists in the ${process.env.STORAGE_BACKEND} store. Register it first.`);
  process.exit(1);
}
console.log(
  result.outcome === 'promoted'
    ? `Promoted ${username.trim().toLowerCase()} (${result.userId}) to ${role}. Its sessions have ended; it signs in again to use the new role.`
    : `${username.trim().toLowerCase()} (${result.userId}) already has role ${role}.`,
);
process.exit(0);
