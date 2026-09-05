import { Router, Request, Response } from 'express';
import { authService } from '../services/authService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const authRouter = Router();

function isValidJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Registration endpoint
// This route is intentionally limited to student accounts; privileged roles are assigned server-side.
authRouter.post('/register', (req: Request, res: Response) => {
  try {
    if (!isValidJsonObject(req.body)) return res.status(400).json({ error: 'Invalid request.' });
    const { email, username, password, name } = req.body;
    const result = authService.register({
      email: String(email || ''),
      username: String(username || ''),
      password: String(password || ''),
      name: name == null ? undefined : String(name),
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user: result.user,
      token: result.token,
    });
  } catch {
    return res.status(400).json({ error: 'Unable to create account.' });
  }
});

// Login endpoint
// Detailed credential failure reasons are deliberately hidden from clients.
authRouter.post('/login', (req: Request, res: Response) => {
  try {
    if (!isValidJsonObject(req.body)) return res.status(400).json({ error: 'Invalid request.' });
    const { username, password } = req.body;
    const result = authService.login(String(username || ''), String(password || ''));

    return res.json({
      success: true,
      message: 'Logged in successfully.',
      user: result.user,
      token: result.token,
    });
  } catch {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
});

// Logout endpoint
authRouter.post('/logout', (req: AuthenticatedRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token) authService.logout(token);
  }
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// Current user profile info
authRouter.get('/me', (req: AuthenticatedRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated.' });
  const user = authService.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User profile not found.' });
  return res.json({ user });
});

// Forgot password.
// Production responses never expose the reset token. Configure an email provider before enabling recovery publicly.
authRouter.post('/forgot-password', (req: Request, res: Response) => {
  try {
    const email = isValidJsonObject(req.body) ? String(req.body.email || '') : '';
    const result = authService.requestPasswordReset(email);
    const response: Record<string, unknown> = {
      success: true,
      message: 'If an account exists for this email, recovery instructions will be sent.',
      expiresMinutes: result.expiresMinutes,
    };

    if (process.env.EXPLICIT_DEV_AUTH === 'true' && result.resetToken) {
      response.devResetToken = result.resetToken;
    }

    return res.json(response);
  } catch {
    // Keep password recovery responses intentionally generic.
    return res.json({
      success: true,
      message: 'If an account exists for this email, recovery instructions will be sent.',
    });
  }
});

// Reset password with a one-time cryptographically random reset token.
authRouter.post('/reset-password', (req: Request, res: Response) => {
  try {
    if (!isValidJsonObject(req.body)) return res.status(400).json({ error: 'Invalid request.' });
    const { email, token, newPassword } = req.body;
    authService.resetPassword(String(email || ''), String(token || ''), String(newPassword || ''));
    return res.json({ success: true, message: 'Password successfully reset.' });
  } catch {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }
});
