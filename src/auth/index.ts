// ─── Auth — JWT, bcrypt, register, login, refresh ───────────────────

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDB } from "../db/index";
import { getConfig, parseDuration } from "../config";
import { audit } from "../audit/logger";

// ─── Schemas ─────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  inviteCode: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export const deviceSchema = z.object({
  deviceName: z.string().min(1, "Device name is required"),
  platform: z.string().default("android"),
});

// ─── Token Helpers ───────────────────────────────────────────────────

interface TokenPayload extends JWTPayload {
  userId: string;
  role: string;
  deviceId?: string;
}

function getSecret(): Uint8Array {
  const config = getConfig();
  return new TextEncoder().encode(config.auth.jwt_secret);
}

export async function createAccessToken(userId: string, role: string, deviceId?: string): Promise<string> {
  const config = getConfig();
  const expiry = parseDuration(config.auth.access_token_expiry);

  return new SignJWT({ userId, role, deviceId } as TokenPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiry}s`)
    .setSubject(userId)
    .sign(getSecret());
}

export async function createStartupAdminAccessToken(
  email: string
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  const sql = getDB();
  const users = await sql`SELECT id, role FROM users WHERE email = ${email} LIMIT 1`;
  if (users.length === 0) {
    throw new AuthError("Admin user not found", 404);
  }

  const user = users[0];
  let devices = await sql`SELECT id FROM devices WHERE user_id = ${user.id} LIMIT 1`;
  if (devices.length === 0) {
    devices = await sql`
      INSERT INTO devices (user_id, name, platform)
      VALUES (${user.id}, 'Default Device', 'android')
      RETURNING id
    `;
  }

  const deviceId = devices[0].id;
  const accessToken = await createAccessToken(user.id, user.role, deviceId);

  return { accessToken, userId: user.id, deviceId };
}

export async function createRefreshToken(
  userId: string,
  deviceId: string
): Promise<{ token: string; hash: string; expiresAt: Date }> {
  const config = getConfig();
  const expiry = parseDuration(config.auth.refresh_token_expiry);

  const token = nanoid(64);
  const hash = await bcrypt.hash(token, 12);
  const expiresAt = new Date(Date.now() + expiry * 1000);

  return { token, hash, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as TokenPayload;
  } catch {
    throw new Error("Invalid or expired token");
  }
}

// ─── Default Persona + Permissions ───────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are Assistant, a helpful AI assistant integrated into an Android phone.
You help the user accomplish tasks by controlling their phone through accessibility services.
Be concise — your responses will be spoken aloud via text-to-speech.
Keep answers under 3 sentences unless asked for detail.
No markdown, no bullet points, no special formatting.
Use plain, conversational language.`;

async function createDefaultPersona(userId: string): Promise<void> {
  const sql = getDB();
  await sql`
    INSERT INTO personas (user_id, name, tone, system_prompt)
    VALUES (${userId}, 'Assistant', 'friendly', ${DEFAULT_SYSTEM_PROMPT})
    ON CONFLICT (user_id) DO NOTHING
  `;
}

async function createDefaultPermissions(userId: string): Promise<void> {
  const sql = getDB();
  await sql`
    INSERT INTO permissions (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `;
}

// ─── Register ────────────────────────────────────────────────────────

export async function register(
  email: string,
  password: string,
  inviteCode?: string
): Promise<{ userId: string; email: string }> {
  const config = getConfig();
  const sql = getDB();

  // Check registration mode
  if (config.server.registration === "disabled") {
    throw new AuthError("Registration is disabled", 403);
  }

  if (config.server.registration === "invite_code") {
    if (!inviteCode || inviteCode !== config.server.invite_code) {
      throw new AuthError("Invalid invite code", 403);
    }
  }

  // Check if user exists
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) {
    throw new AuthError("Email already registered", 409);
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Create user
  const result = await sql`
    INSERT INTO users (email, password_hash)
    VALUES (${email}, ${passwordHash})
    RETURNING id
  `;

  const userId = result[0].id;

  // Create defaults
  await createDefaultPersona(userId);
  await createDefaultPermissions(userId);

  audit("user_registered", { userId, data: { email } });

  return { userId, email };
}

// ─── Login ───────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const sql = getDB();

  const users = await sql`SELECT id, password_hash, role FROM users WHERE email = ${email}`;
  if (users.length === 0) {
    audit("auth_failed", { data: { reason: "User not found", email } });
    throw new AuthError("Invalid credentials", 401);
  }

  const user = users[0];
  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    audit("auth_failed", { userId: user.id, data: { reason: "Wrong password" } });
    throw new AuthError("Invalid credentials", 401);
  }

  // Create or get the default device
  let devices = await sql`SELECT id FROM devices WHERE user_id = ${user.id} LIMIT 1`;
  if (devices.length === 0) {
    devices = await sql`
      INSERT INTO devices (user_id, name, platform)
      VALUES (${user.id}, 'Default Device', 'android')
      RETURNING id
    `;
  }
  const deviceId = devices[0].id;

  const accessToken = await createAccessToken(user.id, user.role, deviceId);

  // Create refresh token
  const rt = await createRefreshToken(user.id, deviceId);
  await sql`
    INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
    VALUES (${user.id}, ${deviceId}, ${rt.hash}, ${rt.expiresAt})
  `;

  audit("user_login", { userId: user.id, deviceId });

  return { accessToken, refreshToken: rt.token, userId: user.id };
}

// ─── Refresh ─────────────────────────────────────────────────────────

export async function refresh(
  refreshToken: string,
  deviceId: string
): Promise<{ accessToken: string }> {
  const sql = getDB();

  // Find all non-revoked, non-expired refresh tokens for this device
  const tokens = await sql`
    SELECT rt.id, rt.token_hash, rt.user_id, u.role
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.device_id = ${deviceId}
      AND rt.revoked = FALSE
      AND rt.expires_at > NOW()
    ORDER BY rt.created_at DESC
  `;

  if (tokens.length === 0) {
    throw new AuthError("No valid refresh token found", 401);
  }

  // Check if provided token matches any stored hash
  let matched: (typeof tokens)[0] | null = null;
  for (const t of tokens) {
    const isValid = await bcrypt.compare(refreshToken, t.token_hash);
    if (isValid) {
      matched = t;
      break;
    }
  }

  if (!matched) {
    throw new AuthError("Invalid refresh token", 401);
  }

  // Revoke used token (rotate)
  await sql`UPDATE refresh_tokens SET revoked = TRUE WHERE id = ${matched.id}`;

  // Issue new access token
  const accessToken = await createAccessToken(matched.user_id, matched.role, deviceId);

  // Issue new refresh token
  const rt = await createRefreshToken(matched.user_id, deviceId);
  await sql`
    INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
    VALUES (${matched.user_id}, ${deviceId}, ${rt.hash}, ${rt.expiresAt})
  `;

  return { accessToken };
}

// ─── Device Registration ─────────────────────────────────────────────

export async function registerDevice(
  userId: string,
  deviceName: string,
  platform: string = "android"
): Promise<{ deviceId: string; accessToken: string; refreshToken: string }> {
  const sql = getDB();

  const result = await sql`
    INSERT INTO devices (user_id, name, platform)
    VALUES (${userId}, ${deviceName}, ${platform})
    RETURNING id
  `;

  const deviceId = result[0].id;
  const user = await sql`SELECT role FROM users WHERE id = ${userId}`;
  const role = user[0]?.role || "user";

  const accessToken = await createAccessToken(userId, role, deviceId);
  const rt = await createRefreshToken(userId, deviceId);

  await sql`
    INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
    VALUES (${userId}, ${deviceId}, ${rt.hash}, ${rt.expiresAt})
  `;

  return { deviceId, accessToken, refreshToken: rt.token };
}

// ─── Logout ──────────────────────────────────────────────────────────

export async function logout(userId: string, deviceId?: string): Promise<void> {
  const sql = getDB();

  if (deviceId) {
    await sql`
      UPDATE refresh_tokens SET revoked = TRUE
      WHERE user_id = ${userId} AND device_id = ${deviceId}
    `;
  } else {
    await sql`
      UPDATE refresh_tokens SET revoked = TRUE
      WHERE user_id = ${userId}
    `;
  }
}

// ─── Create Admin ────────────────────────────────────────────────────

export async function ensureAdmin(email: string, password: string): Promise<void> {
  const sql = getDB();

  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) {
    // Update role to admin if not already
    await sql`UPDATE users SET role = 'admin' WHERE email = ${email}`;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await sql`
    INSERT INTO users (email, password_hash, role)
    VALUES (${email}, ${passwordHash}, 'admin')
    RETURNING id
  `;

  const userId = result[0].id;
  await createDefaultPersona(userId);
  await createDefaultPermissions(userId);

  console.log("  ✅ Admin account created");
}

// ─── Auth Error ──────────────────────────────────────────────────────

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// ─── Rate Limiter (in-memory) ────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}

// Clean up expired rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now >= entry.resetAt) {
      rateLimits.delete(key);
    }
  }
}, 5 * 60 * 1000);
