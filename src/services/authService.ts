import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';

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
  lockoutUntil?: number; // epoch ms
  resetCode?: string;
  resetCodeExpiresAt?: number; // epoch ms
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
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout
const SESSION_TTL_STUDENT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_TTL_ADMIN_MS = 24 * 60 * 60 * 1000; // 24 hours

class AuthService {
  constructor() {
    this.ensureFiles();
    this.seedInitialAccounts();
  }

  private ensureFiles(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
    if (!fs.existsSync(SESSIONS_FILE)) {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf-8');
    }
  }

  private readUsers(): UserAccount[] {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private writeUsers(users: UserAccount[]): void {
    const tempPath = `${USERS_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(users, null, 2), 'utf-8');
    fs.renameSync(tempPath, USERS_FILE);
  }

  private readSessions(): Record<string, UserSession> {
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private writeSessions(sessions: Record<string, UserSession>): void {
    const tempPath = `${SESSIONS_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(sessions, null, 2), 'utf-8');
    fs.renameSync(tempPath, SESSIONS_FILE);
  }

  /**
   * Seed initial admin and examiner accounts with hashed passwords if users DB is empty
   */
  private seedInitialAccounts(): void {
    const users = this.readUsers();
    let modified = false;

    // Check admin
    const adminUsername = (process.env.ADMIN_USER || 'admin').toLowerCase();
    const existingAdmin = users.find(u => u.username.toLowerCase() === adminUsername || u.role === 'admin');
    if (!existingAdmin) {
      const adminPass = process.env.ADMIN_PASSWORD || 'prep2026!admin';
      const salt = bcrypt.genSaltSync(10);
      const passwordHash = bcrypt.hashSync(adminPass, salt);
      users.push({
        id: `usr_admin_${nanoid(8)}`,
        email: 'admin@prepielts.io',
        username: adminUsername,
        name: 'Head of IELTS Content',
        passwordHash,
        role: 'admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        failedLoginAttempts: 0,
      });
      modified = true;
    }

    // Check examiner
    const existingExaminer = users.find(u => u.username.toLowerCase() === 'examiner');
    if (!existingExaminer) {
      const examinerPass = 'cambridge2026';
      const salt = bcrypt.genSaltSync(10);
      const passwordHash = bcrypt.hashSync(examinerPass, salt);
      users.push({
        id: `usr_exam_${nanoid(8)}`,
        email: 'examiner@prepielts.io',
        username: 'examiner',
        name: 'Senior IELTS Examiner',
        passwordHash,
        role: 'examiner',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        failedLoginAttempts: 0,
      });
      modified = true;
    }

    // Seed preview student if not exists
    const existingStudent = users.find(u => u.id === 'usr_student_preview' || u.username === 'student');
    if (!existingStudent) {
      const studentPass = 'student2026';
      const salt = bcrypt.genSaltSync(10);
      const passwordHash = bcrypt.hashSync(studentPass, salt);
      users.push({
        id: 'usr_student_preview',
        email: 'student@prepielts.io',
        username: 'student',
        name: 'Demo Student Candidate',
        passwordHash,
        role: 'student',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        failedLoginAttempts: 0,
      });
      modified = true;
    }

    if (modified) {
      this.writeUsers(users);
    }
  }

  // --- Registration ---
  public register(params: {
    email: string;
    username: string;
    password: string;
    name?: string;
    role?: UserRole;
  }): { user: Omit<UserAccount, 'passwordHash'>; token: string } {
    const { email, username, password, name, role = 'student' } = params;

    // Strict validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Please provide a valid email address.');
    }
    if (!username || username.trim().length < 3) {
      throw new Error('Username must be at least 3 characters long.');
    }
    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters long.');
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();

    const users = this.readUsers();
    if (users.some(u => u.username.toLowerCase() === cleanUsername)) {
      throw new Error('This username is already registered.');
    }
    if (users.some(u => u.email.toLowerCase() === cleanEmail)) {
      throw new Error('An account with this email already exists.');
    }

    // Security: Only allow admin creation via explicit admin API or env seed
    const assignedRole: UserRole = role === 'admin' ? 'student' : role;

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const now = new Date().toISOString();

    const newUser: UserAccount = {
      id: `usr_${nanoid(12)}`,
      email: cleanEmail,
      username: cleanUsername,
      name: name?.trim() || cleanUsername,
      passwordHash,
      role: assignedRole,
      createdAt: now,
      updatedAt: now,
      failedLoginAttempts: 0,
    };

    users.push(newUser);
    this.writeUsers(users);

    // Create session
    const session = this.createSession(newUser);

    const { passwordHash: _, ...safeUser } = newUser;
    return { user: safeUser, token: session.token };
  }

  // --- Login with Brute-Force Rate Limiting ---
  public login(usernameOrEmail: string, password: string): { user: Omit<UserAccount, 'passwordHash'>; token: string } {
    if (!usernameOrEmail || !password) {
      throw new Error('Username/email and password are required.');
    }

    const cleanIdentifier = usernameOrEmail.trim().toLowerCase();
    const users = this.readUsers();
    const userIndex = users.findIndex(
      u => u.username.toLowerCase() === cleanIdentifier || u.email.toLowerCase() === cleanIdentifier
    );

    if (userIndex === -1) {
      throw new Error('Invalid credentials.');
    }

    const user = users[userIndex];
    const now = Date.now();

    // Check Lockout
    if (user.lockoutUntil && user.lockoutUntil > now) {
      const minutesLeft = Math.ceil((user.lockoutUntil - now) / (60 * 1000));
      throw new Error(`Account temporarily locked due to multiple failed login attempts. Please try again in ${minutesLeft} minute(s).`);
    }

    // Verify Password with bcrypt
    const isMatch = bcrypt.compareSync(password, user.passwordHash);
    if (!isMatch) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        user.lockoutUntil = now + LOCKOUT_DURATION_MS;
        user.failedLoginAttempts = 0;
        this.writeUsers(users);
        throw new Error(`Account locked for 15 minutes due to ${MAX_FAILED_ATTEMPTS} consecutive failed attempts.`);
      }
      this.writeUsers(users);
      const remaining = MAX_FAILED_ATTEMPTS - user.failedLoginAttempts;
      throw new Error(`Invalid credentials. ${remaining} attempt(s) remaining before temporary lockout.`);
    }

    // Successful login: reset failed attempts counter
    user.failedLoginAttempts = 0;
    user.lockoutUntil = undefined;
    this.writeUsers(users);

    const session = this.createSession(user);
    const { passwordHash: _, ...safeUser } = user;
    return { user: safeUser, token: session.token };
  }

  // --- Session Management ---
  private createSession(user: UserAccount): UserSession {
    const sessions = this.readSessions();
    const now = Date.now();
    const ttl = user.role === 'admin' ? SESSION_TTL_ADMIN_MS : SESSION_TTL_STUDENT_MS;
    const token = `prep_${user.role}_${nanoid(32)}`;

    const session: UserSession = {
      token,
      userId: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: now,
      expiresAt: now + ttl,
    };

    sessions[token] = session;
    this.writeSessions(sessions);
    return session;
  }

  public validateSession(token: string): UserSession | null {
    if (!token) return null;
    const sessions = this.readSessions();
    const session = sessions[token];
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
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

  // --- Password Reset ---
  public requestPasswordReset(email: string): { code: string; expiresMinutes: number } {
    if (!email) throw new Error('Email is required.');
    const users = this.readUsers();
    const cleanEmail = email.trim().toLowerCase();
    const user = users.find(u => u.email.toLowerCase() === cleanEmail);

    if (!user) {
      // Return a simulated response to prevent email enumeration attacks
      return { code: '123456', expiresMinutes: 15 };
    }

    // 6-digit numeric reset code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const now = Date.now();
    user.resetCode = resetCode;
    user.resetCodeExpiresAt = now + 15 * 60 * 1000; // 15 minutes

    this.writeUsers(users);

    console.log(`[AuthService] Password reset code for ${cleanEmail}: ${resetCode}`);
    return { code: resetCode, expiresMinutes: 15 };
  }

  public resetPassword(email: string, code: string, newPassword: string): void {
    if (!email || !code || !newPassword) {
      throw new Error('Email, verification code, and new password are required.');
    }
    if (newPassword.length < 6) {
      throw new Error('New password must be at least 6 characters.');
    }

    const users = this.readUsers();
    const cleanEmail = email.trim().toLowerCase();
    const user = users.find(u => u.email.toLowerCase() === cleanEmail);

    if (!user || !user.resetCode || user.resetCode !== code.trim()) {
      throw new Error('Invalid or expired verification code.');
    }

    if (user.resetCodeExpiresAt && Date.now() > user.resetCodeExpiresAt) {
      throw new Error('Verification code has expired. Please request a new one.');
    }

    // Set new password
    const salt = bcrypt.genSaltSync(10);
    user.passwordHash = bcrypt.hashSync(newPassword, salt);
    user.resetCode = undefined;
    user.resetCodeExpiresAt = undefined;
    user.failedLoginAttempts = 0;
    user.lockoutUntil = undefined;
    user.updatedAt = new Date().toISOString();

    this.writeUsers(users);

    // Invalidate existing sessions for security
    const sessions = this.readSessions();
    for (const [token, sess] of Object.entries(sessions)) {
      if (sess.userId === user.id) {
        delete sessions[token];
      }
    }
    this.writeSessions(sessions);
  }

  // --- User Administration ---
  public listUsers(): Omit<UserAccount, 'passwordHash'>[] {
    const users = this.readUsers();
    return users.map(({ passwordHash: _, ...safeUser }) => safeUser);
  }

  public getUserById(userId: string): Omit<UserAccount, 'passwordHash'> | null {
    const users = this.readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return null;
    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  public updateUserRole(userId: string, newRole: UserRole): Omit<UserAccount, 'passwordHash'> {
    const users = this.readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
      throw new Error('User not found.');
    }
    user.role = newRole;
    user.updatedAt = new Date().toISOString();
    this.writeUsers(users);

    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }
}

export const authService = new AuthService();
