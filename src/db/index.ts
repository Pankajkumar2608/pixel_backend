// ─── Database Connection Pool ────────────────────────────────────────
// Uses the 'postgres' library (porsager/postgres) — lightweight, no ORM.

import postgres from "postgres";
import { readFileSync } from "fs";
import { resolve } from "path";

let sql: ReturnType<typeof postgres>;

export function getDB(): ReturnType<typeof postgres> {
  if (!sql) {
    throw new Error("Database not initialized. Call connectDB() first.");
  }
  return sql;
}

export async function connectDB(databaseUrl: string): Promise<ReturnType<typeof postgres>> {
  const maxRetries = 5;
  const retryDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      sql = postgres(databaseUrl, {
        max: 20,
        idle_timeout: 20,
        connect_timeout: 10,
      });

      // Test the connection
      await sql`SELECT 1`;
      console.log("  ✅ Database connected");
      return sql;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ DB connection attempt ${attempt}/${maxRetries}: ${message}`);

      if (attempt === maxRetries) {
        throw new Error(`Failed to connect to database after ${maxRetries} attempts`);
      }

      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }

  // TypeScript needs this, but we'll never hit it
  throw new Error("Unreachable");
}

export async function runMigrations(): Promise<void> {
  const schemaPath = resolve(import.meta.dir, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  // Split on semicolons and run each statement
  const statements = schema
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  console.log("  ✅ Schema migrations applied");
}

export async function disconnectDB(): Promise<void> {
  if (sql) {
    await sql.end();
  }
}
