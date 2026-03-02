// ─── Permissions — Per-user app whitelists, spending limits ──────────

import { getDB } from "../db/index";

export interface SpendingLimits {
  perTransaction: number;
  perDay: number;
  requireBiometricAbove: number;
  blockedMerchants: string[];
}

export interface PermissionsData {
  id: string;
  user_id: string;
  allowed_apps: string[];
  blocked_apps: string[];
  spending: SpendingLimits;
}

const DEFAULT_SPENDING: SpendingLimits = {
  perTransaction: 50,
  perDay: 200,
  requireBiometricAbove: 10,
  blockedMerchants: [],
};

export async function getUserPermissions(userId: string): Promise<PermissionsData> {
  const sql = getDB();

  const rows = await sql`
    SELECT id, user_id, allowed_apps, blocked_apps, spending
    FROM permissions
    WHERE user_id = ${userId}
  `;

  if (rows.length === 0) {
    // Create default permissions
    const result = await sql`
      INSERT INTO permissions (user_id)
      VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
      RETURNING id, user_id, allowed_apps, blocked_apps, spending
    `;

    if (result.length === 0) {
      // Already existed via race condition, fetch again
      const retry = await sql`
        SELECT id, user_id, allowed_apps, blocked_apps, spending
        FROM permissions WHERE user_id = ${userId}
      `;
      return normalizePermissions(retry[0]);
    }
    return normalizePermissions(result[0]);
  }

  return normalizePermissions(rows[0]);
}

export async function updatePermissions(
  userId: string,
  updates: {
    allowedApps?: string[];
    blockedApps?: string[];
    spending?: Partial<SpendingLimits>;
  }
): Promise<PermissionsData> {
  const sql = getDB();
  const current = await getUserPermissions(userId);

  const allowedApps = updates.allowedApps ?? current.allowed_apps;
  const blockedApps = updates.blockedApps ?? current.blocked_apps;
  const spending: SpendingLimits = {
    ...current.spending,
    ...updates.spending,
  };

  const result = await sql`
    UPDATE permissions
    SET allowed_apps = ${JSON.stringify(allowedApps)},
        blocked_apps = ${JSON.stringify(blockedApps)},
        spending = ${JSON.stringify(spending)},
        updated_at = NOW()
    WHERE user_id = ${userId}
    RETURNING id, user_id, allowed_apps, blocked_apps, spending
  `;

  return normalizePermissions(result[0]);
}

export function isAppAllowed(perms: PermissionsData, packageName: string): boolean {
  // If blocked_apps contains it → blocked
  if (perms.blocked_apps.includes(packageName)) return false;

  // If allowed_apps is empty → all allowed
  if (perms.allowed_apps.length === 0) return true;

  // If allowed_apps is set → must be in list
  return perms.allowed_apps.includes(packageName);
}

export function checkSpendingLimit(
  perms: PermissionsData,
  amount: number,
  merchant?: string
): { allowed: boolean; reason?: string; requireBiometric: boolean } {
  const { spending } = perms;

  if (merchant && spending.blockedMerchants.includes(merchant)) {
    return { allowed: false, reason: "Merchant is blocked", requireBiometric: false };
  }

  if (amount > spending.perTransaction) {
    return {
      allowed: false,
      reason: `Amount exceeds per-transaction limit of ${spending.perTransaction}`,
      requireBiometric: false,
    };
  }

  const requireBiometric = amount > spending.requireBiometricAbove;

  return { allowed: true, requireBiometric };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizePermissions(row: Record<string, unknown>): PermissionsData {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    allowed_apps: (row.allowed_apps as string[]) || [],
    blocked_apps: (row.blocked_apps as string[]) || [],
    spending: {
      ...DEFAULT_SPENDING,
      ...((row.spending as Partial<SpendingLimits>) || {}),
    },
  };
}
