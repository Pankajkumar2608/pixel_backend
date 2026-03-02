// ─── Task CRUD, Status, Re-planning ─────────────────────────────────

import { getDB } from "../db/index";
import type { ActionStep } from "../llm/planner";
import { audit } from "../audit/logger";

export interface TaskRecord {
  id: string;
  user_id: string;
  device_id: string;
  session_id: string;
  raw_input: string;
  status: "pending" | "executing" | "done" | "failed" | "cancelled";
  plan: ActionStep[] | null;
  current_step: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export async function createTask(opts: {
  userId: string;
  deviceId: string;
  sessionId: string;
  rawInput: string;
  plan: ActionStep[];
}): Promise<string> {
  const sql = getDB();
  const { userId, deviceId, sessionId, rawInput, plan } = opts;

  const result = await sql`
    INSERT INTO tasks (user_id, device_id, session_id, raw_input, status, plan, current_step)
    VALUES (${userId}, ${deviceId}, ${sessionId}, ${rawInput}, 'executing', ${JSON.stringify(plan)}, 0)
    RETURNING id
  `;

  const taskId = result[0].id;

  audit("task_started", {
    userId,
    deviceId,
    sessionId,
    data: { input: rawInput, steps_count: plan.length },
  });

  return taskId;
}

export async function getTask(taskId: string, userId: string): Promise<TaskRecord | null> {
  const sql = getDB();

  const rows = await sql`
    SELECT id, user_id, device_id, session_id, raw_input, status, plan,
           current_step, error, started_at, completed_at
    FROM tasks
    WHERE id = ${taskId} AND user_id = ${userId}
  `;

  if (rows.length === 0) return null;
  return rows[0] as unknown as TaskRecord;
}

export async function getUserTasks(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<TaskRecord[]> {
  const sql = getDB();

  const rows = await sql`
    SELECT id, user_id, device_id, session_id, raw_input, status, plan,
           current_step, error, started_at, completed_at
    FROM tasks
    WHERE user_id = ${userId}
    ORDER BY started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return rows as unknown as TaskRecord[];
}

export async function updateTaskStatus(
  taskId: string,
  status: "pending" | "executing" | "done" | "failed" | "cancelled",
  opts?: { currentStep?: number; error?: string; plan?: ActionStep[] }
): Promise<void> {
  const sql = getDB();

  if (status === "done" || status === "failed" || status === "cancelled") {
    await sql`
      UPDATE tasks
      SET status = ${status},
          current_step = COALESCE(${opts?.currentStep ?? null}, current_step),
          error = ${opts?.error ?? null},
          plan = COALESCE(${opts?.plan ? JSON.stringify(opts.plan) : null}, plan),
          completed_at = NOW()
      WHERE id = ${taskId}
    `;
  } else {
    await sql`
      UPDATE tasks
      SET status = ${status},
          current_step = COALESCE(${opts?.currentStep ?? null}, current_step),
          error = ${opts?.error ?? null},
          plan = COALESCE(${opts?.plan ? JSON.stringify(opts.plan) : null}, plan)
      WHERE id = ${taskId}
    `;
  }
}

export async function getExecutingTasks(deviceId: string): Promise<TaskRecord[]> {
  const sql = getDB();

  const rows = await sql`
    SELECT id, user_id, device_id, session_id, raw_input, status, plan,
           current_step, error, started_at, completed_at
    FROM tasks
    WHERE device_id = ${deviceId} AND status = 'executing'
    ORDER BY started_at DESC
  `;

  return rows as unknown as TaskRecord[];
}

export async function getTaskStats(): Promise<{ totalToday: number }> {
  const sql = getDB();

  const result = await sql`
    SELECT COUNT(*) as count
    FROM tasks
    WHERE started_at >= CURRENT_DATE
  `;

  return { totalToday: parseInt(result[0].count as string, 10) || 0 };
}
