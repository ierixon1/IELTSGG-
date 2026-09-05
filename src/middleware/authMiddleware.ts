import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { initializeApp, getApps, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import { authService, UserRole } from '../services/authService';

export interface AuthenticatedRequest extends Request { userId?: string; userEmail?: string; userRole?: UserRole; userName?: string; }
export const requestContext = new AsyncLocalStorage<{ userId: string }>();

let firebaseApp: App | null = null;
let firebaseAuth: Auth | null = null;
function isExplicitDevAuthEnabled(): boolean { return process.env.EXPLICIT_DEV_AUTH === 'true'; }
function getFirebaseAuth(): Auth | null {
  if (firebaseAuth) return firebaseAuth;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (getApps().length > 0) { firebaseApp = getApps()[0]; firebaseAuth = getAuth(firebaseApp); return firebaseAuth; }
  if (projectId && clientEmail && privateKey) firebaseApp = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  else if (projectId) firebaseApp = initializeApp({ projectId, credential: applicationDefault() });
  else return null;
  firebaseAuth = getAuth(firebaseApp); return firebaseAuth;
}
function isValidRole(value: unknown): value is UserRole { return value === 'student' || value === 'examiner' || value === 'admin'; }

export async function authenticateRequest(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    let userId: string | undefined; let email: string | undefined; let role: UserRole | undefined; let name: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      if (token) {
        const session = authService.validateSession(token);
        if (session) { userId = session.userId; email = session.email; role = session.role; name = session.name; }
        else {
          const auth = getFirebaseAuth();
          if (auth) { try { const decoded = await auth.verifyIdToken(token, true); userId = decoded.uid; email = decoded.email; const claimRole = decoded.role; role = isValidRole(claimRole) ? claimRole : 'student'; } catch {} }
        }
      }
    }
    if (!userId && isExplicitDevAuthEnabled()) {
      const headerUserId = String(req.headers['x-user-id'] || '').trim();
      if (/^[a-zA-Z0-9_\-.]{3,64}$/.test(headerUserId)) { const user = authService.getUserById(headerUserId); if (user) { userId = user.id; email = user.email; role = user.role; name = user.name; } }
    }
    if (!userId) return res.status(401).json({ error: 'Unauthorized.' });
    req.userId = userId; req.userEmail = email; req.userRole = role || 'student'; req.userName = name;
    return requestContext.run({ userId }, next);
  } catch (error: any) { console.error('[AuthMiddleware] Verification error:', error?.message || 'unknown error'); return res.status(401).json({ error: 'Unauthorized.' }); }
}

export function requireRole(allowedRoles: UserRole[]) { return (req: AuthenticatedRequest, res: Response, next: NextFunction) => { if (!req.userId) return res.status(401).json({ error: 'Authentication required.' }); if (!allowedRoles.includes(req.userRole || 'student')) return res.status(403).json({ error: 'Forbidden.' }); return next(); }; }
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) { if (!req.userId) return res.status(401).json({ error: 'Authentication required.' }); return next(); }
