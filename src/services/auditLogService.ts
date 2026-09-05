import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';

export type AdminAuditAction = 
  | 'publish_test' 
  | 'unpublish_test' 
  | 'create_material' 
  | 'update_material' 
  | 'delete_material' 
  | 'create_bundle' 
  | 'update_bundle' 
  | 'delete_bundle' 
  | 'change_user_role'
  | 'admin_login'
  | 'admin_logout';

export interface AdminAuditEntry {
  id: string;
  timestamp: string;
  adminId: string;
  adminName: string;
  adminRole: string;
  action: AdminAuditAction;
  targetType: 'material' | 'bundle' | 'user' | 'auth';
  targetId?: string;
  details?: string;
  ip?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'admin_audit_log.json');

class AuditLogService {
  constructor() {
    this.ensureFile();
  }

  private ensureFile(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  private readEntries(): AdminAuditEntry[] {
    try {
      const raw = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  public record(params: {
    adminId: string;
    adminName: string;
    adminRole: string;
    action: AdminAuditAction;
    targetType: 'material' | 'bundle' | 'user' | 'auth';
    targetId?: string;
    details?: string;
    ip?: string;
  }): AdminAuditEntry {
    const entry: AdminAuditEntry = {
      id: `audit_${Date.now()}_${nanoid(6)}`,
      timestamp: new Date().toISOString(),
      ...params,
    };

    const entries = this.readEntries();
    entries.unshift(entry); // newest first

    // Cap at 2000 entries
    if (entries.length > 2000) {
      entries.length = 2000;
    }

    const tempPath = `${AUDIT_LOG_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(tempPath, AUDIT_LOG_FILE);

    return entry;
  }

  public query(options?: {
    action?: string;
    adminId?: string;
    targetType?: string;
    limit?: number;
    fromDate?: string;
    toDate?: string;
  }): AdminAuditEntry[] {
    let entries = this.readEntries();

    if (options?.action) {
      entries = entries.filter(e => e.action === options.action);
    }
    if (options?.adminId) {
      entries = entries.filter(e => e.adminId === options.adminId);
    }
    if (options?.targetType) {
      entries = entries.filter(e => e.targetType === options.targetType);
    }
    if (options?.fromDate) {
      const from = new Date(options.fromDate).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() >= from);
    }
    if (options?.toDate) {
      const to = new Date(options.toDate).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() <= to);
    }

    const limit = options?.limit || 100;
    return entries.slice(0, limit);
  }
}

export const auditLogService = new AuditLogService();
