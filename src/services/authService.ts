import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import crypto from 'crypto';

export type UserRole = 'student' | 'examiner' | 'admin';

export interface UserAccount {
  id: string;
  email: string;
  username: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  failedLoginAttempts: number;
  lockoutUntil?: number;
  resetTokenHash?: string;
  resetTokenExpiresAt?: number;
}

export interface UserSession {
  token: string;
  userId: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: number;
  expiresAt: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const SESSION_TTL_STUDENT_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_ADMIN_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;

const explicitDevAuth = () => process.env.EXPLICIT_DEV_AUTH === 'true';

class AuthService {
  constructor() {
    this.ensureFiles();
    this.seedInitialAccounts();
  }

  private ensureFiles(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
    if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf-8');
  }

  private readUsers(): UserAccount[] {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); } catch { return []; }
  }

  private writeUsers(users: UserAccount[]): void {
    const tempPath = `${USERS_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(users, null, 2), 'utf-8');
    fs.renameSync(tempPath, USERS_FILE);
  }

  private readSessions(): Record<string, UserSession> {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); } catch { return {}; }
  }

  private writeSessions(sessions: Record<string, UserSession>): void {
    const tempPath = `${SESSIONS_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(sessions, null, 2), 'utf-8');
    fs.renameSync(tempPath, SESSIONS_FILE);
  }

  private seedInitialAccounts(): void {
    if (process.env.SEED_DEFAULT_ACCOUNTS !== 'true') return;

    const adminUser = (process.env.ADMIN_USER || '').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    if (!adminUser || adminPassword.length < 12) {
      throw new Error('SEED_DEFAULT_ACCOUNTS=true requires ADMIN_USER and ADMIN_PASSWORD (minimum 12 characters).');
    }

    const users = this.readUsers();
    let changed = false;

    if (!users.some(u => u.username.toLowerCase() === adminUser || u.role === 'admin')) {
      users.push(this.makeSeedUser({
        id: `usr_admin_${nanoid(8)}`,
        username: adminUser,
        email: process.env.ADMIN_EMAIL || 'admin@prepielts.local',
        name: 'Administrator',
        password: adminPassword,
        role: 'admin',
      }));
      changed = true;
    }

    if (process.env.EXAMINER_SEED_PASSWORD) {
      const examinerPassword = process.env.EXAMINER_SEED_PASSWORD;
      if (!users.some(u => u.username.toLowerCase() === 'examiner')) {
        users.push(this.makeSeedUser({
          id: `usr_exam_${nanoid(8)}`,
          username: 'examiner',
          email: process.env.EXAMINER_EMAIL || 'examiner@prepielts.local',
          name: 'IELTS Examiner',
          password: examinerPassword,
          role: 'examiner',
        }));
        changed = true;
      }
    }

    if (changed) this.writeUsers(users);
  }

  private makeSeedUser(params: {
    id: string;
    username: string;
    email: string;
    name: string;
    password: string;
    role: UserRole;
  }): UserAccount {
    const passwordHash = bcrypt.hashSync(params.password, bcrypt.genSaltSync(12));
    const now = new Date().toISOString();
    return {
      id: params.id,
      username: params.username,
      email: params.email.trim().toLowerCase(),
      name: params.name,
      passwordHash,
      role: params.role,
      createdAt: now,
      updatedAt: now,
      failedLoginAttempts: 0,
    };
  }

  public register(params: {
    email: string;
    username: string;
    password: string;
    name?: string;
  }): { user: Omit<UserAccount, 'passwordHash'>; token: string } {
    const cleanEmail = String(params.email || '').trim().toLowerCase();
    const cleanUsername = String(params.username || '').trim().toLowerCase();
    const password = String(params.password || '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Invalid email or password.');
    if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUsername)) throw new Error('Invalid email or password.');
    if (password.length < 10 || password.length > 128) throw new Error('Invalid email or password.');

    const users = this.readUsers();
    if (users.some(u => u.username.toLowerCase() === cleanUsername || u.email.toLowerCase() === cleanEmail)) {
      throw new Error('Unable to create account with these credentials.');
    }

    const now = new Date().toISOString();
    const user: UserAccount = {
      id: `usr_${nanoid(16)}`,
      email: cleanEmail,
      username: cleanUsername,
      name: String(params.name || cleanUsername).trim().slice(0, 80),
      passwordHash: bcrypt.hashSync(password, bcrypt.genSaltSync(12)),
      role: 'student',
      createdAt: now,
      updatedAt: now,
      failedLoginAttempts: 0,
    };

    users.push(user);
    this.writeUsers(users);
    const session = this.createSession(user);
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { user: safeUser, token: session.token };
  }

  public login(usernameOrEmail: string, password: string): { user: Omit<UserAccount, 'passwordHash'>; token: string } {
    const cleanIdentifier = String(usernameOrEmail || '').trim().toLowerCase();
    const suppliedPassword = String(password || '');
    const users = this.readUsers();
    const userIndex = users.findIndex(u => u.username.toLowerCase() === cleanIdentifier || u.email.toLowerCase() === cleanIdentifier);

    if (userIndex < 0) throw new Error('Invalid credentials.');

    const user = users[userIndex];
    const now = Date.now();
    if (user.lockoutUntil && user.lockoutUntil > now) throw new Error('Too many login attempts. Please try again later.');

    const valid = bcrypt.compareSync(suppliedPassword, user.passwordHash);
    if (!valid) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        user.failedLoginAttempts = 0;
        user.lockoutUntil = now + LOCKOUT_DURATION_MS;
      }
      this.writeUsers(users);
      throw new Error('Invalid credentials.');
    }

    user.failedLoginAttempts = 0;
    delete user.lockoutUntil;
    this.writeUsers(users);

    const session = this.createSession(user);
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { user: safeUser, token: session.token };
  }

  private createSession(user: UserAccount): UserSession {
    const sessions = this.readSessions();
    const now = Date.now();
    const token = `prep_${nanoid(48)}`;
    const session: UserSession = {
      token,
      userId: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: now,
      expiresAt: now + (user.role === 'admin' ? SESSION_TTL_ADMIN_MS : SESSION_TTL_STUDENT_MS),
    };
    sessions[token] = session;
    this.writeSessions(sessions);
    return session;
  }

  public validateSession(token: string): UserSession | null {
    const sessions = this.readSessions();
    const session = sessions[token];
    if (!session) return null;
    if (Date.now() >= session.expiresAt) {
      delete sessions[token];
      this.writeSessions(sessions);
      return null;
    }
    return session;
  }

  public logout(token: string): void {
    if (!token) return;
    const sessions = this.readSessions();
    if (sessions[token]) {
      delete sessions[token];
      this.writeSessions(sessions);
    }
  }

  public requestPasswordReset(email: string): { resetToken?: string; expiresMinutes: number } {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const users = this.readUsers();
    const user = users.find(u => u.email.toLowerCase() === cleanEmail);
    const expiresMinutes = PASSWORD_RESET_TTL_MS / 60000;

    if (!user) return { expiresMinutes };

    const resetToken = crypto.randomBytes(32).toString('base64url');
    user.resetTokenHash = this.hashResetToken(resetToken);
    user.resetTokenExpiresAt = Date.now() + PASSWORD_RESET_TTL_MS;
    this.writeUsers(users);

    // In production this token must be delivered by an email provider, never returned to the client.
    return explicitDevAuth() ? { resetToken, expiresMinutes } : { expiresMinutes };
  }

  private hashResetToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  public resetPassword(email: string, token: string, newPassword: string): void {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (newPassword.length < 10 || newPassword.length > 128) throw new Error('Invalid password.');

    const users = this.readUsers();
    const user = users.find(u => u.email.toLowerCase() === cleanEmail);
    if (!user || !user.resetTokenHash || !user.resetTokenExpiresAt || Date.now() >= user.resetTokenExpiresAt) {
      throw new Error('Invalid or expired reset token.');
    }

    const suppliedHash = this.hashResetToken(String(token || '').trim());
    if (!crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(user.resetTokenHash))) {
      throw new Error('Invalid or expired reset token.');
    }

    user.passwordHash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(12));
    delete user.resetTokenHash;
    delete user.resetTokenExpiresAt;
    user.failedLoginAttempts = 0;
    delete user.lockoutUntil;
    user.updatedAt = new Date().toISOString();
    this.writeUsers(users);

    const sessions = this.readSessions();
    for (const [sessionToken, session] of Object.entries(sessions)) {
      if (session.userId === user.id) delete sessions[sessionToken];
    }
    this.writeSessions(sessions);
  }

  public listUsers(): Omit<UserAccount, 'passwordHash'>[] {
    return this.readUsers().map(({ passwordHash: _passwordHash, ...safeUser }) => safeUser);
  }

  public getUserById(userId: string): Omit<UserAccount, 'passwordHash'> | null {
    const user = this.readUsers().find(u => u.id === userId);
    if (!user) return null;
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return safeUser;
  }

  public updateUserRole(userId: string, newRole: UserRole): Omit<UserAccount, 'passwordHash'> {
    if (!['student', 'examiner', 'admin'].includes(newRole)) throw new Error('Invalid role.');
    const users = this.readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) throw new Error('User not found.');
    user.role = newRole;
    user.updatedAt = new Date().toISOString();
    this.writeUsers(users);
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return safeUser;
  }
}

export const authService = new AuthService();
