-- Pixel AI Server — Database Schema
-- Safe to run on every startup (IF NOT EXISTS)

-- Users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT DEFAULT 'user',     -- user | admin
  gemini_model  TEXT,                    -- override default model
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Devices (one user can have multiple)
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  platform      TEXT DEFAULT 'android',
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash    TEXT UNIQUE NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Personas (one per user)
CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT DEFAULT 'Assistant',
  tone          TEXT DEFAULT 'friendly', -- friendly | professional | concise
  system_prompt TEXT NOT NULL,
  preferences   JSONB DEFAULT '{}',
  memory        JSONB DEFAULT '[]',      -- learned facts array
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Permissions (one per user)
CREATE TABLE IF NOT EXISTS permissions (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  allowed_apps  JSONB DEFAULT '[]',      -- empty = all apps allowed
  blocked_apps  JSONB DEFAULT '[]',
  spending      JSONB DEFAULT '{
    "perTransaction": 50,
    "perDay": 200,
    "requireBiometricAbove": 10,
    "blockedMerchants": []
  }',
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks (survive server restart)
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  raw_input     TEXT NOT NULL,
  status        TEXT DEFAULT 'pending',  -- pending | executing | done | failed
  plan          JSONB,                   -- full ActionStep array
  current_step  INT DEFAULT 0,
  error         TEXT,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_user    ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_devices_user  ON devices(user_id);
