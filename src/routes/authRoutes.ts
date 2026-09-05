import { Router, Request, Response } from 'express';
import { authService } from '../services/authService';

export const authRouter = Router();

function isValidJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAuthenticatedUser(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token ? authService.validateSession(token) : null;
}

authRouter.post('/register', (req: Request, res: Response) => {
  try {
    if (!isValidJsonObject(req.body)) return res.status(400).json({ error: 'Invalid request.' });
    const result = authService.register({
      email: String(req.body.email || ''),
      username: String(req.body.username || ''),
      password: String(req.body.password || ''),
      name: req.body.name == null ? undefined : String(req.body.name),
    });
    return res.status(201).json({ success: true, message: 'Account created successfully.', user: result.user, token: result.token });
  } catch {
    return res.status(400).json({ error: 'Unable to create account.' });
  }
});

authRouter.post('/login', (req: Request, res: Response) => {
  try {
    if (!isValidJsonObject(req.body)) return res.status(400).json({ error: 'Invalid request.' });
    const result = authService.login(String(req.body.username || ''), String(req.body.password || ''));
    return res.json({ success: true, message: 'Logged in successfully.', user: result.user, token: result.token });
  } catch {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) authService.logout(header.slice('Bearer '.length).trim());
  return res.json({ success: true, message: 'Logged out successfully.' });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const session = getAuthenticatedUser(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized.' });
  const user = authService.getUserById(session.userId);
  if (!user) return res.status(404).json({ error: 'User profile not found.' });
  return res.json({ user });
});

authRouter.post('/forgot-password', (req: Request, res: Response) => {
  try {
    const email = isValidJsonObject(req.body) ? String(req.body.email || '') : '';
    const result = authService.requestPasswordReset(email);
    const response: Record<string, unknown> = {
      success: true,
      message: 'If an account exists for this email, recovery instructions will be sent.',
      expiresMinutes: result.expiresMinutes,
    };
    if (process.env.EXPLICIT_DEV_AUTH === 'true' && result.resetToken) response.devResetToken = result.resetToken;
    return res.json(response);
  } catch {
    return res.json({ success: true, message: 'If an account exists for this email, recovery instructions will be sent.' });
  }
});

authRouter.post('/reset-password', (req: Request, res: Response) => {
  try {
    if (!isValidJsonObject(req.body)) return res.status(400).json({ error: 'Invalid request.' });
    authService.resetPassword(String(req.body.email || ''), String(req.body.token || ''), String(req.body.newPassword || ''));
    return res.json({ success: true, message: 'Password successfully reset.' });
  } catch {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }
});
