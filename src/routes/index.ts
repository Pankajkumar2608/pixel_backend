// ─── REST API Routes ─────────────────────────────────────────────────

import { Hono } from "hono";
import type { Context, Next, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  register,
  login,
  refresh,
  registerDevice,
  logout,
  loginSchema,
  registerSchema,
  refreshSchema,
  deviceSchema,
  verifyAccessToken,
  checkRateLimit,
  AuthError,
} from "../auth/index";
import { getPersona, updatePersona } from "../persona/index";
import { getUserPermissions, updatePermissions } from "../permissions/index";
import { getUserTasks, getTask, getTaskStats } from "../tasks/index";
import { getActiveConnectionCount } from "../ws/manager";
import { getDB } from "../db/index";
import { getConfig } from "../config";
import { audit } from "../audit/logger";
import { planAction } from "../llm/planner";
import type { LLMProvider } from "../llm/interface";

const startTime = Date.now();
let llmProviderRef: LLMProvider | null = null;

// ─── Custom context type for auth ────────────────────────────────────

type AuthVariables = {
  userId: string;
  role: string;
  deviceId: string | undefined;
};

type AuthApp = Hono<{ Variables: AuthVariables }>;

export function createRoutes(llm: LLMProvider): AuthApp {
  llmProviderRef = llm;
  const app: AuthApp = new Hono<{ Variables: AuthVariables }>();

  // ─── Middleware: Auth ──────────────────────────────────────────────

  const authMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return c.json({ error: "Missing authorization header" }, 401 as const);
    }

    try {
      const token = auth.slice(7);
      const payload = await verifyAccessToken(token);
      c.set("userId", payload.userId);
      c.set("role", payload.role);
      c.set("deviceId", payload.deviceId);
      await next();
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401 as const);
    }
  };

  const adminMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (c.get("role") !== "admin") {
      return c.json({ error: "Admin access required" }, 403 as const);
    }
    await next();
  };

  // ─── Health ────────────────────────────────────────────────────────

  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      version: "1.0.0",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      connections: getActiveConnectionCount(),
    });
  });

  // ─── Auth: Register ────────────────────────────────────────────────

  app.post("/api/auth/register", async (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const rl = checkRateLimit(`register:${ip}`, 5, 3600_000);
    if (!rl.allowed) {
      return c.json({ error: "Too many registration attempts. Try again later." }, 429 as const);
    }

    try {
      const body = await c.req.json();
      const validated = registerSchema.parse(body);
      const result = await register(validated.email, validated.password, validated.inviteCode);
      return c.json(result, 201 as const);
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: err.message }, err.status as 400);
      }
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
      }
      console.error("Register error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Auth: Login ───────────────────────────────────────────────────

  app.post("/api/auth/login", async (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const rl = checkRateLimit(`login:${ip}`, 10, 15 * 60_000);
    if (!rl.allowed) {
      return c.json({ error: "Too many login attempts. Try again later." }, 429 as const);
    }

    try {
      const body = await c.req.json();
      const validated = loginSchema.parse(body);
      const result = await login(validated.email, validated.password);
      return c.json(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: err.message }, err.status as 401);
      }
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
      }
      console.error("Login error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Auth: Refresh ─────────────────────────────────────────────────

  app.post("/api/auth/refresh", async (c) => {
    try {
      const body = await c.req.json();
      const validated = refreshSchema.parse(body);
      const result = await refresh(validated.refreshToken, validated.deviceId);
      return c.json(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: err.message }, err.status as 401);
      }
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
      }
      console.error("Refresh error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Auth: Device Registration ─────────────────────────────────────

  app.post("/api/auth/device", authMiddleware, async (c) => {
    try {
      const body = await c.req.json();
      const validated = deviceSchema.parse(body);
      const userId = c.get("userId");
      const result = await registerDevice(userId, validated.deviceName, validated.platform);
      return c.json(result, 201 as const);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
      }
      console.error("Device registration error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Auth: Logout ──────────────────────────────────────────────────

  app.post("/api/auth/logout", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const deviceId = c.get("deviceId");
      await logout(userId, deviceId);
      return c.json({ message: "Logged out successfully" });
    } catch (err) {
      console.error("Logout error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Persona ───────────────────────────────────────────────────────

  app.get("/api/persona", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const persona = await getPersona(userId);
      return c.json(persona);
    } catch (err) {
      console.error("Get persona error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  app.patch("/api/persona", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const body = await c.req.json();

      const updateSchema = z.object({
        name: z.string().min(1).max(50).optional(),
        tone: z.enum(["friendly", "professional", "concise"]).optional(),
        preferences: z.record(z.unknown()).optional(),
      });

      const validated = updateSchema.parse(body);
      const persona = await updatePersona(userId, validated);
      return c.json(persona);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
      }
      console.error("Update persona error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Permissions ───────────────────────────────────────────────────

  app.get("/api/permissions", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const perms = await getUserPermissions(userId);
      return c.json(perms);
    } catch (err) {
      console.error("Get permissions error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  app.patch("/api/permissions", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const body = await c.req.json();

      const updateSchema = z.object({
        allowedApps: z.array(z.string()).optional(),
        blockedApps: z.array(z.string()).optional(),
        spending: z
          .object({
            perTransaction: z.number().optional(),
            perDay: z.number().optional(),
            requireBiometricAbove: z.number().optional(),
            blockedMerchants: z.array(z.string()).optional(),
          })
          .optional(),
      });

      const validated = updateSchema.parse(body);
      const perms = await updatePermissions(userId, validated);
      return c.json(perms);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
      }
      console.error("Update permissions error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Tasks ─────────────────────────────────────────────────────────

  app.get("/api/tasks", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const limit = parseInt(c.req.query("limit") || "20", 10);
      const offset = parseInt(c.req.query("offset") || "0", 10);
      const tasks = await getUserTasks(userId, Math.min(limit, 100), Math.max(offset, 0));
      return c.json({ tasks, limit, offset });
    } catch (err) {
      console.error("Get tasks error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  app.get("/api/tasks/:id", authMiddleware, async (c) => {
    try {
      const userId = c.get("userId");
      const taskId = c.req.param("id");
      const task = await getTask(taskId, userId);

      if (!task) {
        return c.json({ error: "Task not found" }, 404 as const);
      }

      return c.json(task);
    } catch (err) {
      console.error("Get task error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Admin ─────────────────────────────────────────────────────────

  app.get("/api/admin/users", authMiddleware, adminMiddleware, async (c) => {
    try {
      const sql = getDB();
      const users = await sql`
        SELECT id, email, role, gemini_model, created_at
        FROM users ORDER BY created_at DESC
      `;
      return c.json({ users });
    } catch (err) {
      console.error("Admin users error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  app.delete("/api/admin/users/:id", authMiddleware, adminMiddleware, async (c) => {
    try {
      const sql = getDB();
      const userId = c.req.param("id");
      const currentUserId = c.get("userId");

      if (userId === currentUserId) {
        return c.json({ error: "Cannot delete your own account" }, 400 as const);
      }

      await sql`DELETE FROM users WHERE id = ${userId}`;
      return c.json({ message: "User deleted" });
    } catch (err) {
      console.error("Admin delete user error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  app.get("/api/admin/stats", authMiddleware, adminMiddleware, async (c) => {
    try {
      const sql = getDB();
      const userCount = await sql`SELECT COUNT(*) as count FROM users`;
      const taskStats = await getTaskStats();

      return c.json({
        activeConnections: getActiveConnectionCount(),
        totalUsers: parseInt(userCount[0].count as string, 10),
        totalTasksToday: taskStats.totalToday,
        serverUptime: Math.floor((Date.now() - startTime) / 1000),
      });
    } catch (err) {
      console.error("Admin stats error:", err);
      return c.json({ error: "Internal server error" }, 500 as const);
    }
  });

  // ─── Test Endpoint (dev only) ──────────────────────────────────────

  if (process.env.NODE_ENV === "development") {
    const testQuerySchema = z.object({
      text: z.string().min(1),
      uiTree: z.string().optional(),
      currentApp: z.string().optional(),
    });

    app.post("/api/test/query", async (c) => {
      try {
        const body = await c.req.json();
        const validated = testQuerySchema.parse(body);

        if (!llmProviderRef) {
          return c.json({ error: "LLM provider not configured" }, 500 as const);
        }

        const result = await planAction(llmProviderRef, {
          queryId: `test-${Date.now()}`,
          userId: "test-user",
          text: validated.text,
          uiTree: validated.uiTree,
          currentApp: validated.currentApp,
          sessionId: "test-session",
          deviceId: "test-device",
        });

        return c.json(result);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return c.json({ error: err.issues.map((i) => i.message).join(", ") }, 400 as const);
        }
        console.error("Test query error:", err);
        return c.json({ error: "Internal server error" }, 500 as const);
      }
    });
  }

  return app;
}
