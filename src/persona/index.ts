// ─── Persona — Identity, Memory, Prompt Builder ─────────────────────

import { getDB } from "../db/index";

export interface MemoryItem {
  fact: string;
  confidence: number;
  learnedAt: string;
}

export interface PersonaData {
  id: string;
  user_id: string;
  name: string;
  tone: string;
  system_prompt: string;
  preferences: Record<string, unknown>;
  memory: MemoryItem[];
}

const DEFAULT_SYSTEM_PROMPT = `You are Assistant, a helpful AI assistant integrated into an Android phone.
You help the user accomplish tasks by controlling their phone through accessibility services.
Be concise — your responses will be spoken aloud via text-to-speech.
Keep answers under 3 sentences unless asked for detail.
No markdown, no bullet points, no special formatting.
Use plain, conversational language.`;

export async function getPersona(userId: string): Promise<PersonaData> {
  const sql = getDB();

  const rows = await sql`
    SELECT id, user_id, name, tone, system_prompt, preferences, memory
    FROM personas
    WHERE user_id = ${userId}
  `;

  if (rows.length === 0) {
    // Create default persona if missing
    const result = await sql`
      INSERT INTO personas (user_id, name, tone, system_prompt)
      VALUES (${userId}, 'Assistant', 'friendly', ${DEFAULT_SYSTEM_PROMPT})
      RETURNING id, user_id, name, tone, system_prompt, preferences, memory
    `;
    return normalizePersona(result[0]);
  }

  return normalizePersona(rows[0]);
}

export async function updatePersona(
  userId: string,
  updates: { name?: string; tone?: string; preferences?: Record<string, unknown> }
): Promise<PersonaData> {
  const sql = getDB();
  const current = await getPersona(userId);

  const name = updates.name ?? current.name;
  const tone = updates.tone ?? current.tone;
  const preferences = updates.preferences ?? current.preferences;

  // Rebuild system prompt with new name and tone
  const systemPrompt = `You are ${name}, a helpful AI assistant integrated into an Android phone.
Tone: ${tone}
Be concise — your responses will be spoken aloud via text-to-speech.
Keep answers under 3 sentences unless asked for detail.
No markdown, no bullet points, no special formatting.
Use plain, conversational language.`;

  const result = await sql`
    UPDATE personas
    SET name = ${name},
        tone = ${tone},
        system_prompt = ${systemPrompt},
        preferences = ${JSON.stringify(preferences)},
        updated_at = NOW()
    WHERE user_id = ${userId}
    RETURNING id, user_id, name, tone, system_prompt, preferences, memory
  `;

  return normalizePersona(result[0]);
}

export async function addMemory(userId: string, fact: string, confidence: number = 0.7): Promise<void> {
  const sql = getDB();
  const persona = await getPersona(userId);

  const memory = [...(persona.memory || [])];

  // Check if similar memory exists
  const existingIdx = memory.findIndex(
    (m) => m.fact.toLowerCase().includes(fact.toLowerCase().slice(0, 20))
  );

  if (existingIdx >= 0) {
    // Update confidence of existing memory
    memory[existingIdx].confidence = Math.min(1, memory[existingIdx].confidence + 0.1);
    memory[existingIdx].learnedAt = new Date().toISOString();
  } else {
    // Add new memory
    const newMemory: MemoryItem = {
      fact,
      confidence,
      learnedAt: new Date().toISOString(),
    };
    memory.push(newMemory);
  }

  // Keep max 50 — drop lowest confidence
  if (memory.length > 50) {
    memory.sort((a, b) => b.confidence - a.confidence);
    memory.splice(50);
  }

  await sql`
    UPDATE personas
    SET memory = ${JSON.stringify(memory)},
        updated_at = NOW()
    WHERE user_id = ${userId}
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizePersona(row: Record<string, unknown>): PersonaData {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    name: (row.name as string) || "Assistant",
    tone: (row.tone as string) || "friendly",
    system_prompt: (row.system_prompt as string) || DEFAULT_SYSTEM_PROMPT,
    preferences: (row.preferences as Record<string, unknown>) || {},
    memory: (row.memory as MemoryItem[]) || [],
  };
}
