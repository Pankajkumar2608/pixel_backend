// ─── Audit Logger — Flat File, Daily Rotation ───────────────────────
// One JSON-per-line log file per day: ./logs/YYYY-MM-DD.log
// Append-only. Auto-deletes files older than retention_days.

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join, resolve } from "path";

export interface AuditEvent {
  ts: string;
  userId?: string;
  deviceId?: string;
  sessionId?: string;
  event: string;
  data?: Record<string, unknown>;
}

type AuditEventName =
  | "user_registered"
  | "user_login"
  | "device_connected"
  | "device_disconnected"
  | "query_received"
  | "local_handled"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_replanned"
  | "task_cancelled"
  | "task_confirmed"
  | "injection_detected"
  | "permission_blocked"
  | "auth_failed"
  | "server_started"
  | "server_error";

let logDir: string = "./logs";
let retentionDays: number = 90;

export function initAuditLogger(dir: string, retention: number): void {
  logDir = resolve(dir);
  retentionDays = retention;

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Clean old logs on startup
  cleanOldLogs();
}

function getLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return join(logDir, `${date}.log`);
}

export function audit(
  event: AuditEventName,
  opts?: {
    userId?: string;
    deviceId?: string;
    sessionId?: string;
    data?: Record<string, unknown>;
  }
): void {
  const entry: AuditEvent = {
    ts: new Date().toISOString(),
    userId: opts?.userId,
    deviceId: opts?.deviceId,
    sessionId: opts?.sessionId,
    event,
    data: opts?.data,
  };

  const line = JSON.stringify(entry) + "\n";
  const filePath = getLogFilePath();

  try {
    appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    // If directory doesn't exist, create and retry
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(filePath, line, "utf-8");
    } catch {
      console.error("Failed to write audit log:", err);
    }
  }
}

function cleanOldLogs(): void {
  try {
    const files = readdirSync(logDir);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    for (const file of files) {
      if (!file.endsWith(".log")) continue;

      // Extract date from filename: YYYY-MM-DD.log
      const dateStr = file.replace(".log", "");
      const fileDate = new Date(dateStr);

      if (!isNaN(fileDate.getTime()) && fileDate < cutoff) {
        unlinkSync(join(logDir, file));
        console.log(`Deleted old log: ${file}`);
      }
    }
  } catch {
    // First run — no logs dir yet, that's fine
  }
}
