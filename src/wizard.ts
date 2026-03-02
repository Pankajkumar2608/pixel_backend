// ─── First-Run Terminal Wizard ──────────────────────────────────────
// Interactive setup that creates config.yaml on first launch.
// Uses Bun's readline-compatible approach for terminal input.

import { writeFileSync } from "fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./config";
import * as readline from "readline";

interface WizardAnswers {
  port: number;
  apiKey: string;
  model: string;
  registration: string;
  inviteCode: string;
  adminEmail: string;
  adminPassword: string;
}

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

function generateSecret(length: number = 48): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

export async function runWizard(): Promise<void> {
  const rl = createInterface();

  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   🤖  Pixel AI Server — Setup        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");
  console.log("No config found. Starting setup wizard...");
  console.log("");

  // Gather answers
  const portStr = await question(rl, "? Server port (3000): ");
  const port = portStr ? parseInt(portStr, 10) : 3000;

  const apiKey = await question(rl, "? Your Gemini API key: ");
  if (!apiKey) {
    console.error("❌ Gemini API key is required.");
    rl.close();
    process.exit(1);
  }

  const modelInput = await question(rl, "? Default Gemini model (gemini-2.0-flash-exp): ");
  const model = modelInput || "gemini-2.0-flash-exp";

  const regMode = await question(
    rl,
    "? Allow public registration? (open/invite_code/disabled) [open]: "
  );
  const registration = ["open", "invite_code", "disabled"].includes(regMode)
    ? regMode
    : "open";

  let inviteCode = "";
  if (registration === "invite_code") {
    inviteCode = await question(rl, "? Invite code: ");
    if (!inviteCode) {
      console.error("❌ Invite code is required in invite_code mode.");
      rl.close();
      process.exit(1);
    }
  }

  const adminEmail = await question(rl, "? Admin email: ");
  if (!adminEmail || !adminEmail.includes("@")) {
    console.error("❌ A valid admin email is required.");
    rl.close();
    process.exit(1);
  }

  const adminPassword = await question(rl, "? Admin password (min 8 chars): ");
  if (!adminPassword || adminPassword.length < 8) {
    console.error("❌ Password must be at least 8 characters.");
    rl.close();
    process.exit(1);
  }

  const confirmPassword = await question(rl, "? Confirm password: ");
  if (adminPassword !== confirmPassword) {
    console.error("❌ Passwords do not match.");
    rl.close();
    process.exit(1);
  }

  rl.close();

  // Validate Gemini API key
  process.stdout.write("\nValidating Gemini API key...  ");
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const testModel = genAI.getGenerativeModel({ model });
    await testModel.generateContent("Say hello in one word.");
    console.log("✅");
  } catch (err) {
    console.log("❌");
    console.error("  Invalid API key or model. Check your Gemini credentials.");
    console.error("  Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Determine database URL based on environment
  const isDocker = process.env.NODE_ENV === "production";
  const dbUrl = isDocker
    ? "postgresql://postgres:postgres@db:5432/pixelai"
    : "postgresql://postgres:postgres@localhost:5432/pixelai";

  // Generate config
  const config = {
    server: {
      port,
      host: "0.0.0.0",
      registration,
      invite_code: inviteCode,
    },
    ai: {
      provider: "gemini",
      api_key: apiKey,
      model,
      available_models: [
        "gemini-2.0-flash-exp",
        "gemini-2.5-pro-exp",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
      ],
    },
    auth: {
      jwt_secret: generateSecret(48),
      access_token_expiry: "15m",
      refresh_token_expiry: "30d",
    },
    database: {
      url: dbUrl,
    },
    audit: {
      log_dir: "./logs",
      retention_days: 90,
    },
    admin: {
      email: adminEmail,
      password: adminPassword,
    },
  };

  process.stdout.write("Writing config.yaml...       ");
  writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120 }), "utf-8");
  console.log("✅");

  console.log("");
  console.log("Setup complete! The server will now start.");
  console.log("");
}
