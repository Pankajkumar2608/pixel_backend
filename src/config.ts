// ─── Config Loader — config.yaml + Zod validation ──────────────────

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { z } from "zod";

const configSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(3000),
    host: z.string().default("0.0.0.0"),
    registration: z.enum(["open", "invite_code", "disabled"]).default("open"),
    invite_code: z.string().optional().default(""),
  }),
  ai: z.object({
    provider: z.string().default("gemini"),
    api_key: z.string().min(1, "Gemini API key is required"),
    model: z.string().default("gemini-2.0-flash-exp"),
    available_models: z.array(z.string()).default([
      "gemini-2.0-flash-exp",
      "gemini-2.5-pro-exp",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash",
    ]),
  }),
  auth: z.object({
    jwt_secret: z.string().min(32, "JWT secret must be at least 32 characters"),
    access_token_expiry: z.string().default("15m"),
    refresh_token_expiry: z.string().default("30d"),
  }),
  database: z.object({
    url: z.string().min(1, "Database URL is required"),
  }),
  audit: z.object({
    log_dir: z.string().default("./logs"),
    retention_days: z.number().int().min(1).default(90),
  }),
  admin: z
    .object({
      email: z.string().email().optional(),
      password: z.string().min(8).optional(),
    })
    .optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

let cachedConfig: AppConfig | null = null;

export const CONFIG_PATH = resolve(process.cwd(), "config.yaml");

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = yaml.load(raw) as Record<string, unknown>;

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  → ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config.yaml:\n${errors}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

/** Parse duration strings like "15m", "30d", "1h" into seconds */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}
