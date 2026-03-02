// ─── WebSocket Manager — Lifecycle + Routing ─────────────────────────
// Handles WS connections, auth timeout, ping/pong, and message routing.

import type { ServerWebSocket } from "bun";
import { nanoid } from "nanoid";
import { verifyAccessToken } from "../auth/index";
import { audit } from "../audit/logger";
import { planAction, replanFromStep, type ActionStep } from "../llm/planner";
import { createTask, updateTaskStatus, getTask, getExecutingTasks } from "../tasks/index";
import { addMemory } from "../persona/index";
import { checkRateLimit } from "../auth/index";
import type { LLMProvider } from "../llm/interface";

// ─── Types ───────────────────────────────────────────────────────────

export interface Connection {
  ws: ServerWebSocket<WebSocketData>;
  userId: string;
  deviceId: string;
  sessionId: string;
  connectedAt: number;
  currentTask?: string;
}

export interface WebSocketData {
  id: string;
  authenticated: boolean;
  authTimeout?: ReturnType<typeof setTimeout>;
  userId?: string;
  deviceId?: string;
  sessionId?: string;
  preAuthToken?: string;
  preAuthDeviceId?: string;
}

// ─── In-Memory Connection Store ──────────────────────────────────────

const connections = new Map<string, Connection>();

const MAX_REPLANS_PER_TASK = 3;
const replanCounts = new Map<string, number>();

let llmProvider: LLMProvider;

export function setLLMProvider(provider: LLMProvider): void {
  llmProvider = provider;
}

export function getActiveConnectionCount(): number {
  return connections.size;
}

export function getConnections(): Map<string, Connection> {
  return connections;
}

// ─── WebSocket Handlers ──────────────────────────────────────────────

export function handleOpen(ws: ServerWebSocket<WebSocketData>): void {
  const id = nanoid();
  ws.data = {
    ...ws.data,
    id,
    authenticated: false,
  };

  // 5-second auth timeout
  ws.data.authTimeout = setTimeout(() => {
    if (!ws.data.authenticated) {
      sendMessage(ws, { type: "AUTH_FAILED", message: "Auth timeout — no AUTH received in 5 seconds" });
      ws.close(4001, "Auth timeout");
    }
  }, 5000);
  if (ws.data.preAuthToken && ws.data.preAuthDeviceId) {
    void authenticateSocket(ws, ws.data.preAuthToken, ws.data.preAuthDeviceId).catch((err) => {
      const message = err instanceof Error ? err.message : "Authentication failed";
      audit("auth_failed", { data: { reason: message } });
      sendMessage(ws, { type: "AUTH_FAILED", message });
      ws.close(4001, "Auth failed");
    });
  }
}

export function handleClose(ws: ServerWebSocket<WebSocketData>): void {
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
  }

  if (ws.data.sessionId) {
    const conn = connections.get(ws.data.sessionId);
    if (conn) {
      audit("device_disconnected", {
        userId: conn.userId,
        deviceId: conn.deviceId,
        sessionId: conn.sessionId,
      });
      connections.delete(ws.data.sessionId);
    }
  }
}

export async function handleMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: string | Buffer
): Promise<void> {
  let data: Record<string, unknown>;

  try {
    const raw = typeof message === "string" ? message : message.toString();
    data = JSON.parse(raw);
  } catch {
    sendMessage(ws, { type: "ERROR", message: "Invalid JSON" });
    return;
  }

  const type = data.type as string;

  try {
    switch (type) {
      case "AUTH":
        await handleAuth(ws, data);
        break;

      case "VOICE_QUERY":
        await handleVoiceQuery(ws, data);
        break;

      case "TASK_FAILED":
        await handleTaskFailed(ws, data);
        break;

      case "TASK_COMPLETED":
        await handleTaskCompleted(ws, data);
        break;

      case "TASK_CONFIRM":
        await handleTaskConfirm(ws, data);
        break;

      case "PING":
        sendMessage(ws, { type: "PONG" });
        break;

      default:
        sendMessage(ws, { type: "ERROR", message: `Unknown message type: ${type}` });
    }
  } catch (err) {
    console.error(`WS message error:`, err);
    sendMessage(ws, { type: "ERROR", message: "Internal server error" });
  }
}

// ─── Auth Handler ────────────────────────────────────────────────────

async function handleAuth(
  ws: ServerWebSocket<WebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  const token = data.token as string;
  const deviceId = data.deviceId as string;

  if (!token || !deviceId) {
    sendMessage(ws, { type: "AUTH_FAILED", message: "Missing token or deviceId" });
    ws.close(4001, "Missing credentials");
    return;
  }

  try {
    await authenticateSocket(ws, token, deviceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Authentication failed";
    audit("auth_failed", { data: { reason: message } });
    sendMessage(ws, { type: "AUTH_FAILED", message });
    ws.close(4001, "Auth failed");
  }
}

// ─── Voice Query Handler ─────────────────────────────────────────────

async function authenticateSocket(
  ws: ServerWebSocket<WebSocketData>,
  token: string,
  deviceId: string
): Promise<void> {
  const payload = await verifyAccessToken(token);

  // Clear auth timeout
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
  }

  const sessionId = nanoid();

  ws.data.authenticated = true;
  ws.data.userId = payload.userId;
  ws.data.deviceId = deviceId;
  ws.data.sessionId = sessionId;
  ws.data.preAuthToken = undefined;
  ws.data.preAuthDeviceId = undefined;

  // Store connection
  connections.set(sessionId, {
    ws,
    userId: payload.userId,
    deviceId,
    sessionId,
    connectedAt: Date.now(),
  });

  audit("device_connected", {
    userId: payload.userId,
    deviceId,
    sessionId,
  });

  sendMessage(ws, {
    type: "AUTH_SUCCESS",
    userId: payload.userId,
    sessionId,
  });

  // Check for any executing tasks for this device (reconnection scenario)
  const pendingTasks = await getExecutingTasks(deviceId);
  for (const task of pendingTasks) {
    if (task.plan && task.plan.length > 0) {
      sendMessage(ws, {
        type: "TASK",
        queryId: task.session_id,
        taskId: task.id,
        understanding: task.raw_input,
        confirmRequired: false,
        steps: task.plan.slice(task.current_step),
        confirmationText: "Resuming previous task",
      });
    }
  }
}

async function handleVoiceQuery(
  ws: ServerWebSocket<WebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  if (!ws.data.authenticated || !ws.data.userId) {
    sendMessage(ws, { type: "AUTH_FAILED", message: "Not authenticated" });
    return;
  }

  const queryId = data.queryId as string;
  const text = data.text as string;
  const uiTree = data.uiTree as string | undefined;
  const currentApp = data.currentApp as string | undefined;

  if (!queryId || !text) {
    sendMessage(ws, { type: "ERROR", message: "Missing queryId or text" });
    return;
  }

  // Rate limit: 30 queries per minute per user
  const rl = checkRateLimit(`ws:${ws.data.userId}`, 30, 60_000);
  if (!rl.allowed) {
    sendMessage(ws, {
      type: "ANSWER",
      queryId,
      text: "You're sending requests too fast. Please wait a moment.",
    });
    return;
  }

  if (!llmProvider) {
    sendMessage(ws, {
      type: "ANSWER",
      queryId,
      text: "The AI engine is not configured. Please check server settings.",
    });
    return;
  }

  // Plan the action
  const result = await planAction(llmProvider, {
    queryId,
    userId: ws.data.userId,
    text,
    uiTree,
    currentApp,
    sessionId: ws.data.sessionId!,
    deviceId: ws.data.deviceId!,
  });

  if (result.type === "ANSWER") {
    sendMessage(ws, {
      type: "ANSWER",
      queryId: result.queryId,
      text: result.text,
    });
    return;
  }

  // Create task in DB
  const taskId = await createTask({
    userId: ws.data.userId,
    deviceId: ws.data.deviceId!,
    sessionId: ws.data.sessionId!,
    rawInput: text,
    plan: result.steps!,
  });

  // Update connection with current task
  const conn = connections.get(ws.data.sessionId!);
  if (conn) conn.currentTask = taskId;

  if (result.confirmRequired) {
    sendMessage(ws, {
      type: "CONFIRM_REQUIRED",
      taskId,
      action: "task_execution",
      details: result.understanding,
    });
    return;
  }

  sendMessage(ws, {
    type: "TASK",
    queryId: result.queryId,
    taskId,
    understanding: result.understanding,
    confirmRequired: false,
    steps: result.steps,
    confirmationText: result.confirmationText,
  });
}

// ─── Task Failed Handler ─────────────────────────────────────────────

async function handleTaskFailed(
  ws: ServerWebSocket<WebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  if (!ws.data.authenticated || !ws.data.userId) return;

  const taskId = data.taskId as string;
  const failedStep = data.failedStep as number;
  const reason = data.reason as string;
  const currentApp = data.currentApp as string;
  const uiTree = data.uiTree as string;

  if (!taskId || failedStep === undefined) {
    sendMessage(ws, { type: "ERROR", message: "Missing taskId or failedStep" });
    return;
  }

  // Check replan count
  const replanCount = replanCounts.get(taskId) || 0;
  if (replanCount >= MAX_REPLANS_PER_TASK) {
    await updateTaskStatus(taskId, "failed", {
      error: `Max replans exceeded: ${reason}`,
      currentStep: failedStep,
    });

    audit("task_failed", {
      userId: ws.data.userId,
      deviceId: ws.data.deviceId,
      sessionId: ws.data.sessionId,
      data: { taskId, reason: "Max replans exceeded", step: failedStep },
    });

    sendMessage(ws, {
      type: "ANSWER",
      queryId: taskId,
      text: "I couldn't complete that task after several attempts. Could you try rephrasing your request?",
    });
    return;
  }

  // Get the original task
  const task = await getTask(taskId, ws.data.userId);
  if (!task || !task.plan) {
    sendMessage(ws, { type: "ERROR", message: "Task not found" });
    return;
  }

  audit("task_failed", {
    userId: ws.data.userId,
    deviceId: ws.data.deviceId,
    sessionId: ws.data.sessionId,
    data: { taskId, reason, step: failedStep },
  });

  // Re-plan remaining steps
  const newSteps = await replanFromStep(llmProvider, {
    userId: ws.data.userId,
    originalInput: task.raw_input,
    failedStep,
    reason,
    currentApp: currentApp || "unknown",
    uiTree: uiTree || "",
    previousSteps: task.plan as ActionStep[],
    sessionId: ws.data.sessionId!,
    deviceId: ws.data.deviceId!,
  });

  if (!newSteps || newSteps.length === 0) {
    await updateTaskStatus(taskId, "failed", {
      error: `Re-plan failed: ${reason}`,
      currentStep: failedStep,
    });

    sendMessage(ws, {
      type: "ANSWER",
      queryId: taskId,
      text: "I couldn't figure out an alternative approach. Could you try a different way?",
    });
    return;
  }

  replanCounts.set(taskId, replanCount + 1);

  // Update task with new plan
  const fullPlan = [...(task.plan as ActionStep[]).slice(0, failedStep), ...newSteps];
  await updateTaskStatus(taskId, "executing", {
    plan: fullPlan,
    currentStep: failedStep,
  });

  audit("task_replanned", {
    userId: ws.data.userId,
    deviceId: ws.data.deviceId,
    sessionId: ws.data.sessionId,
    data: { taskId, from_step: failedStep },
  });

  sendMessage(ws, {
    type: "TASK_REPLAN",
    taskId,
    fromStep: failedStep,
    steps: newSteps,
  });
}

// ─── Task Completed Handler ──────────────────────────────────────────

async function handleTaskCompleted(
  ws: ServerWebSocket<WebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  if (!ws.data.authenticated || !ws.data.userId) return;

  const taskId = data.taskId as string;
  if (!taskId) return;

  const task = await getTask(taskId, ws.data.userId);
  if (!task) return;

  const startedAt = new Date(task.started_at).getTime();
  const durationMs = Date.now() - startedAt;

  await updateTaskStatus(taskId, "done");

  audit("task_completed", {
    userId: ws.data.userId,
    deviceId: ws.data.deviceId,
    sessionId: ws.data.sessionId,
    data: { taskId, duration_ms: durationMs },
  });

  // Clean up replan counter
  replanCounts.delete(taskId);

  // Clear current task from connection
  const conn = connections.get(ws.data.sessionId!);
  if (conn) conn.currentTask = undefined;

  // Extract memory from completed task
  try {
    if (task.raw_input && task.plan) {
      // Simple memory extraction — could be enhanced with LLM later
      const input = task.raw_input.toLowerCase();
      if (input.includes("spotify") || input.includes("music")) {
        await addMemory(ws.data.userId, "User uses Spotify for music", 0.7);
      }
      if (input.includes("whatsapp")) {
        await addMemory(ws.data.userId, "User uses WhatsApp for messaging", 0.7);
      }
      if (input.includes("uber") || input.includes("ola")) {
        const app = input.includes("uber") ? "Uber" : "Ola";
        await addMemory(ws.data.userId, `User prefers ${app} for rides`, 0.7);
      }
    }
  } catch {
    // Memory extraction is best-effort
  }
}

// ─── Task Confirm Handler ────────────────────────────────────────────

async function handleTaskConfirm(
  ws: ServerWebSocket<WebSocketData>,
  data: Record<string, unknown>
): Promise<void> {
  if (!ws.data.authenticated || !ws.data.userId) return;

  const taskId = data.taskId as string;
  const confirmed = data.confirmed as boolean;

  if (!taskId) {
    sendMessage(ws, { type: "ERROR", message: "Missing taskId" });
    return;
  }

  const task = await getTask(taskId, ws.data.userId);
  if (!task || !task.plan) {
    sendMessage(ws, { type: "ERROR", message: "Task not found" });
    return;
  }

  if (!confirmed) {
    await updateTaskStatus(taskId, "cancelled");
    audit("task_cancelled", {
      userId: ws.data.userId,
      deviceId: ws.data.deviceId,
      sessionId: ws.data.sessionId,
      data: { taskId },
    });
    sendMessage(ws, {
      type: "ANSWER",
      queryId: taskId,
      text: "Task cancelled.",
    });
    return;
  }

  // User confirmed — send the task steps
  await updateTaskStatus(taskId, "executing");

  audit("task_confirmed", {
    userId: ws.data.userId,
    deviceId: ws.data.deviceId,
    sessionId: ws.data.sessionId,
    data: { taskId },
  });

  sendMessage(ws, {
    type: "TASK",
    queryId: task.session_id,
    taskId,
    understanding: task.raw_input,
    confirmRequired: false,
    steps: task.plan,
    confirmationText: "Proceeding with your request.",
  });
}

// ─── Ping/Pong keepalive ─────────────────────────────────────────────

// Ping all connections every 30 seconds
setInterval(() => {
  for (const [sessionId, conn] of connections) {
    try {
      conn.ws.ping();
    } catch {
      connections.delete(sessionId);
    }
  }
}, 30_000);

// ─── Helpers ─────────────────────────────────────────────────────────

function sendMessage(ws: ServerWebSocket<WebSocketData>, data: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // Connection may be dead
  }
}
