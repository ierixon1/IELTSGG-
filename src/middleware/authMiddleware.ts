import { Request, Response, NextFunction } from 'express';
import { initializeApp, getApps, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

const DEFAULT_DEV_USER = 'usr_student_preview';

/**
 * Lazy initialization of Firebase Admin SDK
 * Safely loads credentials from environment or GCP Application Default Credentials (ADC)
 */
let firebaseApp: App | null = null;
let firebaseAuth: Auth | null = null;

function getFirebaseAuth(): Auth | null {
  if (firebaseAuth) return firebaseAuth;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    firebaseAuth = getAuth(firebaseApp);
    return firebaseAuth;
  }

  if (projectId && clientEmail && privateKey) {
    firebaseApp = initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
    firebaseAuth = getAuth(firebaseApp);
    return firebaseAuth;
  } else if (projectId) {
    // Uses Google Cloud Run metadata server / Application Default Credentials (ADC)
    firebaseApp = initializeApp({
      projectId,
      credential: applicationDefault(),
    });
    firebaseAuth = getAuth(firebaseApp);
    return firebaseAuth;
  }

  return null;
}

/**
 * Authentication Middleware:
 * Strict Fail-Closed Security Architecture:
 *
 * PRODUCTION RULES (NODE_ENV === 'production'):
 * - STRICT FAIL-CLOSED: Every incoming request MUST supply a cryptographically valid
 *   Firebase ID Token in the Authorization: Bearer header.
 * - Tokens are verified via admin.auth().verifyIdToken(token).
 * - If token is missing, expired, revoked, or signature invalid -> IMMEDIATELY 401.
 * - No mock tokens or fallback users are EVER permitted in production.
 *
 * DEVELOPMENT RULES (NODE_ENV !== 'production'):
 * - If a Firebase ID token is provided and Admin is configured, verifies it.
 * - Otherwise permits local development workflows using x-user-id or fallback dev session.
 */
export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    const isProduction = process.env.NODE_ENV === 'production';
    let resolvedUserId: string | null = null;
    let resolvedEmail: string | undefined = undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1]?.trim();

      if (token) {
        const auth = getFirebaseAuth();
        if (auth) {
          try {
            // Real cryptographic verification of the Firebase ID Token
            const decoded = await auth.verifyIdToken(token);
            resolvedUserId = decoded.uid;
            resolvedEmail = decoded.email;
          } catch (verifyErr: any) {
            if (isProduction) {
              console.warn('[AuthMiddleware] Production token verification failed:', verifyErr.message);
              return res.status(401).json({
                error: 'Unauthorized: Invalid or expired Firebase ID token.',
              });
            }
            // In dev mode, if token verification fails, allow token string as dev ID if length > 3
            if (token.length > 3 && !token.includes('.')) {
              resolvedUserId = token;
            }
          }
        } else if (!isProduction) {
          // In local dev when Admin SDK credentials are not configured
          if (token.length > 3) {
            resolvedUserId = token;
          }
        }
      }
    }

    // PRODUCTION: Enforce strict fail-closed security
    if (isProduction) {
      if (!resolvedUserId) {
        return res.status(401).json({
          error: 'Unauthorized: Valid Firebase Bearer token is required in production.',
        });
      }
      req.userId = resolvedUserId;
      req.userEmail = resolvedEmail;
      return next();
    }

    // DEVELOPMENT: Allow x-user-id header or fallback for AI Studio container preview
    if (!resolvedUserId && req.headers['x-user-id']) {
      const headerUserId = String(req.headers['x-user-id']).trim();
      if (/^[a-zA-Z0-9_\-\.]{3,64}$/.test(headerUserId)) {
        resolvedUserId = headerUserId;
      }
    }

    req.userId = resolvedUserId || DEFAULT_DEV_USER;
    req.userEmail = resolvedEmail;

    next();
  } catch (error: any) {
    console.error('[AuthMiddleware] Verification error:', error.message);
    res.status(401).json({ error: 'Unauthorized: Authentication failed.' });
  }
}
