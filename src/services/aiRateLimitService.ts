import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';

export type AiOperationType = 'writing_grade' | 'speaking_grade' | 'mock_generation' | 'preppy_chat';

export interface AiUsageRecord {
  id: string;
  userId: string;
  timestamp: string;
  operation: AiOperationType;
  model: string;
  wordCount?: number;
  durationMs?: number;
  success: boolean;
  notes?: string;
}

export interface AiQuotaLimits {
  daily: number;
  hourly: number;
}

export const AI_OPERATION_LIMITS: Record<AiOperationType, AiQuotaLimits> = {
  writing_grade: { daily: 10, hourly: 4 },
  speaking_grade: { daily: 10, hourly: 4 },
  mock_generation: { daily: 10, hourly: 3 },
  preppy_chat: { daily: 30, hourly: 10 },
};

const DATA_DIR = path.join(process.cwd(), 'data');
const USAGE_LOG_FILE = path.join(DATA_DIR, 'ai_usage_log.json');

class AiRateLimitService {
  constructor() {
    this.ensureFile();
  }

  private ensureFile(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(USAGE_LOG_FILE)) {
      fs.writeFileSync(USAGE_LOG_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  private readLogs(): AiUsageRecord[] {
    try {
      const raw = fs.readFileSync(USAGE_LOG_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private appendLog(record: AiUsageRecord): void {
    const logs = this.readLogs();
    logs.push(record);
    // Keep max 5000 records to maintain fast I/O
    if (logs.length > 5000) {
      logs.splice(0, logs.length - 5000);
    }
    const tempPath = `${USAGE_LOG_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(logs, null, 2), 'utf-8');
    fs.renameSync(tempPath, USAGE_LOG_FILE);
  }

  /**
   * Check if user is within limits for a specific AI operation.
   * Returns { allowed: boolean, reason?: string, currentDaily: number, maxDaily: number, currentHourly: number, maxHourly: number }
   */
  public checkLimit(userId: string, operation: AiOperationType): {
    allowed: boolean;
    reason?: string;
    currentDaily: number;
    maxDaily: number;
    currentHourly: number;
    maxHourly: number;
  } {
    const limits = AI_OPERATION_LIMITS[operation] || { daily: 10, hourly: 5 };
    const logs = this.readLogs();
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const todayDateStr = new Date().toISOString().slice(0, 10);

    const userLogs = logs.filter(l => l.userId === userId && l.operation === operation && l.success);

    const currentDaily = userLogs.filter(l => l.timestamp.startsWith(todayDateStr)).length;
    const currentHourly = userLogs.filter(l => new Date(l.timestamp).getTime() > oneHourAgo).length;

    if (currentHourly >= limits.hourly) {
      const opName = operation.replace('_', ' ');
      return {
        allowed: false,
        reason: `Hourly AI limit reached (${limits.hourly} ${opName} requests per hour). Please pause for a few minutes before trying again.`,
        currentDaily,
        maxDaily: limits.daily,
        currentHourly,
        maxHourly: limits.hourly,
      };
    }

    if (currentDaily >= limits.daily) {
      const opName = operation.replace('_', ' ');
      return {
        allowed: false,
        reason: `Daily AI quota reached (${limits.daily} ${opName} evaluations per day). Your limit will reset at midnight UTC.`,
        currentDaily,
        maxDaily: limits.daily,
        currentHourly,
        maxHourly: limits.hourly,
      };
    }

    return {
      allowed: true,
      currentDaily,
      maxDaily: limits.daily,
      currentHourly,
      maxHourly: limits.hourly,
    };
  }

  /**
   * Record a completed or attempted AI operation
   */
  public recordUsage(params: {
    userId: string;
    operation: AiOperationType;
    model: string;
    wordCount?: number;
    durationMs?: number;
    success: boolean;
    notes?: string;
  }): void {
    const record: AiUsageRecord = {
      id: `ai_log_${Date.now()}_${nanoid(6)}`,
      userId: params.userId,
      timestamp: new Date().toISOString(),
      operation: params.operation,
      model: params.model,
      wordCount: params.wordCount,
      durationMs: params.durationMs,
      success: params.success,
      notes: params.notes,
    };
    this.appendLog(record);
  }

  /**
   * Admin inspection of AI logs with filtering
   */
  public getUsageLogs(options?: {
    userId?: string;
    operation?: AiOperationType;
    limit?: number;
  }): { records: AiUsageRecord[]; summary: Record<string, number> } {
    let logs = this.readLogs();

    if (options?.userId) {
      logs = logs.filter(l => l.userId === options.userId);
    }
    if (options?.operation) {
      logs = logs.filter(l => l.operation === options.operation);
    }

    const summary: Record<string, number> = {};
    for (const log of logs) {
      summary[log.operation] = (summary[log.operation] || 0) + 1;
      summary[`user_${log.userId}`] = (summary[`user_${log.userId}`] || 0) + 1;
    }

    // Sort newest first
    logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const limit = options?.limit || 100;
    return {
      records: logs.slice(0, limit),
      summary,
    };
  }
}

export const aiRateLimitService = new AiRateLimitService();
