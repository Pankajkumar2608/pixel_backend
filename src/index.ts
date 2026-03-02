// ─── Pixel AI Server — Entry Point ───────────────────────────────────
// Startup sequence:
// 1. Check config.yaml → run wizard if missing
// 2. Connect to PostgreSQL (retry 5x)
// 3. Run schema migrations
// 4. Create admin account if configured
// 5. Start Hono HTTP + WebSocket server
// 6. Print startup banner

import { configExists, loadConfig, type AppConfig } from "./config";
import { runWizard } from "./wizard";
import { connectDB, runMigrations, getDB } from "./db/index";
import { initAuditLogger, audit } from "./audit/logger";
import { ensureAdmin, createStartupAdminAccessToken } from "./auth/index";
import { createRoutes } from "./routes/index";
import { createGeminiProvider } from "./llm/gemini";
import {
  handleOpen,
  handleClose,
  handleMessage,
  setLLMProvider,
  getActiveConnectionCount,
  type WebSocketData,
} from "./ws/manager";

async function main(): Promise<void> {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   🤖  Pixel AI Server                ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");

  // ─── Step 1: Config ──────────────────────────────────────────────

  if (!configExists()) {
    await runWizard();
  }

  let config: AppConfig;
  try {
    config = loadConfig();
    console.log("  ✅ Config loaded");
  } catch (err) {
    console.error("  ❌ Config error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ─── Step 2: Audit Logger ────────────────────────────────────────

  initAuditLogger(config.audit.log_dir, config.audit.retention_days);
  console.log("  ✅ Audit logger initialized");

  // ─── Step 3: Database ────────────────────────────────────────────

  try {
    await connectDB(config.database.url);
  } catch (err) {
    console.error("  ❌ Database error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ─── Step 4: Migrations ──────────────────────────────────────────

  try {
    await runMigrations();
  } catch (err) {
    console.error("  ❌ Migration error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ─── Step 5: Admin Account ───────────────────────────────────────

  if (config.admin?.email && config.admin?.password) {
    try {
      await ensureAdmin(config.admin.email, config.admin.password);
    } catch (err) {
      console.error("  ⚠️  Admin creation warning:", err instanceof Error ? err.message : err);
    }
  }
  let startupAdminToken: { accessToken: string; userId: string; deviceId: string } | null = null;
  if (config.admin?.email) {
    try {
      startupAdminToken = await createStartupAdminAccessToken(config.admin.email);
      console.log("  [ok] Startup admin access token generated");
    } catch (err) {
      console.error("  [warn] Startup token warning:", err instanceof Error ? err.message : err);
    }
  }

  const wsHost =
    config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
  const wsBaseUrl = `ws://${wsHost}:${config.server.port}/ws`;

  // ─── Step 6: LLM Provider ───────────────────────────────────────

  const llm = createGeminiProvider(config.ai.api_key, config.ai.model);
  setLLMProvider(llm);
  console.log(`  ✅ LLM provider: ${llm.name} (${llm.model})`);

  // ─── Step 7: Routes ──────────────────────────────────────────────

  const app = createRoutes(llm);

  // ─── Step 8: Start Server ────────────────────────────────────────

  const userCount = await getDB()`SELECT COUNT(*) as count FROM users`;
  const users = parseInt(userCount[0].count as string, 10);

  audit("server_started", {
    data: {
      port: config.server.port,
      model: config.ai.model,
      registration: config.server.registration,
    },
  });

  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,

    // HTTP handler — Hono
    fetch(req, server) {
      // Check for WebSocket upgrade
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const token = url.searchParams.get("token") ?? undefined;
        const deviceId = url.searchParams.get("deviceId") ?? undefined;
        const success = server.upgrade(req, {
          data: {
            id: "",
            authenticated: false,
            preAuthToken: token,
            preAuthDeviceId: deviceId,
          } as WebSocketData,
        });
        if (success) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req);
    },

    // WebSocket handlers
    websocket: {
      open: handleOpen,
      close: handleClose,
      message: handleMessage,
      perMessageDeflate: true,
      maxPayloadLength: 1024 * 1024, // 1MB max
      idleTimeout: 120, // 2 minutes
    },
  });

  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log(`║   🤖  Pixel AI Server                ║`);
  console.log(`║   HTTP:  http://${config.server.host}:${config.server.port}        ║`);
  console.log(`║   WS:    ${wsBaseUrl.padEnd(31)}║`);
  console.log(`║   DB:    connected                   ║`);
  console.log(`║   Users: ${String(users).padEnd(27)}║`);
  console.log("╚══════════════════════════════════════╝");
  console.log("");

  if (startupAdminToken) {
    const adminWsUrl = `${wsBaseUrl}?token=${encodeURIComponent(
      startupAdminToken.accessToken
    )}&deviceId=${encodeURIComponent(startupAdminToken.deviceId)}`;
    console.log("  Admin auth (startup):");
    console.log(`  userId:   ${startupAdminToken.userId}`);
    console.log(`  deviceId: ${startupAdminToken.deviceId}`);
    console.log(`  token:    ${startupAdminToken.accessToken}`);
    console.log(`  wsUrl:    ${adminWsUrl}`);
  }

  // ─── Graceful Shutdown ───────────────────────────────────────────

  const shutdown = async () => {
    console.log("\n🛑 Shutting down...");
    server.stop();
    const { disconnectDB } = await import("./db/index");
    await disconnectDB();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});




