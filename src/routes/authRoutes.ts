import { Router, Request, Response } from 'express';
import { authService } from '../services/authService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export const authRouter = Router();

// Registration endpoint
authRouter.post('/register', (req: Request, res: Response) => {
  try {
    const { email, username, password, name } = req.body;
    const result = authService.register({
      email,
      username,
      password,
      name,
      role: 'student',
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user: result.user,
      token: result.token,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Registration failed.' });
  }
});

// Login endpoint (with brute-force protection)
authRouter.post('/login', (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const result = authService.login(username, password);

    res.json({
      success: true,
      message: 'Logged in successfully.',
      user: result.user,
      token: result.token,
    });
  } catch (error: any) {
    const isLocked = error.message?.includes('locked');
    res.status(isLocked ? 429 : 401).json({ error: error.message || 'Login failed.' });
  }
});

// Logout endpoint
authRouter.post('/logout', (req: AuthenticatedRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1]?.trim();
    if (token) {
      authService.logout(token);
    }
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

// Current User profile info
authRouter.get('/me', (req: AuthenticatedRequest, res: Response) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const user = authService.getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User profile not found.' });
  }

  res.json({ user });
});

// Forgot Password request
authRouter.post('/forgot-password', (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const { code, expiresMinutes } = authService.requestPasswordReset(email);
    // In production, this would be emailed; in dev/preview, return verification code for seamless UX
    res.json({
      success: true,
      message: `Password reset code sent. Valid for ${expiresMinutes} minutes.`,
      code, // Helpful preview code for immediate testing
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Password reset request failed.' });
  }
});

// Reset Password confirmation
authRouter.post('/reset-password', (req: Request, res: Response) => {
  try {
    const { email, code, newPassword } = req.body;
    authService.resetPassword(email, code, newPassword);
    res.json({
      success: true,
      message: 'Password successfully reset. You can now log in with your new password.',
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Password reset failed.' });
  }
});
