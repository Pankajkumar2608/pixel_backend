// ─── Task Planner — The Brain ────────────────────────────────────────
// Classifies intent (QUESTION vs TASK), builds system prompts,
// calls LLM, parses/validates the response, runs security checks.

import { z } from "zod";
import type { LLMProvider } from "./interface";
import { getPersona } from "../persona/index";
import { getUserPermissions } from "../permissions/index";
import { audit } from "../audit/logger";

// ─── Types ───────────────────────────────────────────────────────────

export interface ActionStep {
  id: string;
  action: string;
  target?: string;
  value?: string;
  packageName?: string;
  milliseconds?: number;
  description: string;
}

export interface TaskPlanResult {
  type: "ANSWER" | "TASK";
  queryId: string;
  // Answer fields
  text?: string;
  // Task fields
  taskId?: string;
  understanding?: string;
  impossible?: boolean;
  impossibleReason?: string;
  confirmRequired?: boolean;
  steps?: ActionStep[];
  confirmationText?: string;
}

// ─── Zod schema for Gemini's task response ──────────────────────────

const actionStepSchema = z.object({
  id: z.string(),
  action: z.enum([
    "launch_app",
    "tap",
    "type",
    "scroll_down",
    "scroll_up",
    "swipe_left",
    "swipe_right",
    "back",
    "home",
    "wait",
    "call_contact",
    "send_message",
    "open_url",
    "press_enter",
  ]),
  target: z.string().optional(),
  value: z.string().optional(),
  packageName: z.string().optional(),
  milliseconds: z.number().optional(),
  contactName: z.string().optional(),
  phoneNumber: z.string().optional(),
  url: z.string().optional(),
  description: z.string(),
});

const taskResponseSchema = z.object({
  type: z.literal("TASK"),
  understanding: z.string(),
  impossible: z.boolean().default(false),
  impossibleReason: z.string().nullable().optional(),
  confirmRequired: z.boolean().default(false),
  steps: z.array(actionStepSchema).default([]),
  confirmationText: z.string().optional(),
});

// ─── Intent Classification ───────────────────────────────────────────

const TASK_VERBS = [
  "play",
  "send",
  "open",
  "call",
  "set",
  "navigate",
  "search",
  "download",
  "book",
  "order",
  "buy",
  "install",
  "turn on",
  "turn off",
  "enable",
  "disable",
  "share",
  "post",
  "create",
  "delete",
  "remove",
  "start",
  "stop",
  "pause",
  "resume",
  "go to",
  "launch",
  "tap",
  "click",
  "type",
  "scroll",
  "swipe",
  "take a photo",
  "record",
  "text",
  "message",
  "reply",
  "pay",
  "transfer",
];

export function classifyIntent(text: string): "QUESTION" | "TASK" {
  const lower = text.toLowerCase().trim();

  // If it starts with a question word and doesn't have task verbs → question
  const questionStarters = ["what", "who", "where", "when", "why", "how", "is", "are", "was", "were", "do", "does", "can", "could", "would", "should", "tell me about", "explain"];
  const startsWithQuestion = questionStarters.some((q) => lower.startsWith(q));

  // Check for task verbs
  const hasTaskVerb = TASK_VERBS.some((verb) => lower.includes(verb));

  // If both — task verbs win (e.g., "can you play spotify" is a task)
  if (hasTaskVerb) return "TASK";
  if (startsWithQuestion) return "QUESTION";

  // Default: let Gemini decide by treating as question
  return "QUESTION";
}

// ─── Local Command Handler ──────────────────────────────────────────
// Handles simple commands instantly without calling the LLM.
// This is faster, cheaper, and more reliable for basic tasks.

const APP_NAME_TO_PACKAGE: Record<string, string> = {
  // Social & Messaging
  "whatsapp": "com.whatsapp",
  "whats app": "com.whatsapp",
  "instagram": "com.instagram.android",
  "insta": "com.instagram.android",
  "facebook": "com.facebook.katana",
  "fb": "com.facebook.katana",
  "twitter": "com.twitter.android",
  "x": "com.twitter.android",
  "telegram": "org.telegram.messenger",
  "snapchat": "com.snapchat.android",
  "linkedin": "com.linkedin.android",
  "threads": "com.instagram.barcelona",
  "discord": "com.discord",
  "messenger": "com.facebook.orca",
  "signal": "org.thoughtcrime.securesms",

  // Media & Entertainment
  "spotify": "com.spotify.music",
  "youtube": "com.google.android.youtube",
  "you tube": "com.google.android.youtube",
  "youtube music": "com.google.android.apps.youtube.music",
  "netflix": "com.netflix.mediaclient",
  "hotstar": "in.startv.hotstar",
  "disney plus": "in.startv.hotstar",
  "amazon prime": "com.amazon.avod.thirdpartyclient",
  "prime video": "com.amazon.avod.thirdpartyclient",
  "jio cinema": "com.jio.media.ondemand",
  "jiotv": "com.jio.jioplay.tv",

  // Google Apps
  "chrome": "com.android.chrome",
  "gmail": "com.google.android.gm",
  "google maps": "com.google.android.apps.maps",
  "maps": "com.google.android.apps.maps",
  "google pay": "com.google.android.apps.nbu.paisa.user",
  "gpay": "com.google.android.apps.nbu.paisa.user",
  "google photos": "com.google.android.apps.photos",
  "photos": "com.google.android.apps.photos",
  "gallery": "com.google.android.apps.photos",
  "google drive": "com.google.android.apps.docs",
  "drive": "com.google.android.apps.docs",
  "google keep": "com.google.android.keep",
  "keep notes": "com.google.android.keep",
  "notes": "com.google.android.keep",
  "calendar": "com.google.android.calendar",
  "google calendar": "com.google.android.calendar",
  "messages": "com.google.android.apps.messaging",
  "contacts": "com.google.android.contacts",
  "files": "com.google.android.apps.nbu.files",
  "clock": "com.google.android.deskclock",
  "alarm": "com.google.android.deskclock",
  "timer": "com.google.android.deskclock",
  "calculator": "com.google.android.calculator",
  "google": "com.google.android.googlequicksearchbox",

  // System
  "camera": "com.android.camera",
  "settings": "com.android.settings",
  "phone": "com.android.dialer",
  "dialer": "com.android.dialer",

  // Shopping & Food
  "amazon": "in.amazon.mShop.android.shopping",
  "flipkart": "com.flipkart.android",
  "myntra": "com.myntra.android",
  "swiggy": "in.swiggy.android",
  "zomato": "com.application.zomato",

  // Payments
  "phonepe": "com.phonepe.app",
  "phone pe": "com.phonepe.app",
  "paytm": "net.one97.paytm",
  "cred": "com.dreamplug.androidapp",

  // Transport
  "uber": "com.ubercab",
  "ola": "com.olacabs.customer",
  "rapido": "com.rapido.passenger",

  // Other
  "truecaller": "com.truecaller",
  "reddit": "com.reddit.frontpage",
};

/**
 * Tries to handle simple commands locally without calling the LLM.
 * Returns a TaskPlanResult if handled, null if the LLM should take over.
 */
function tryHandleLocally(text: string, queryId: string): TaskPlanResult | null {
  const lower = text.toLowerCase().trim();

  // ── Pattern 1: "open/launch {app}" ──────────────────────────────
  const openAppMatch = lower.match(
    /^(?:open|launch|start|go to|run|can you open|please open|open up)\s+(?:the\s+)?(.+?)(?:\s+app)?$/i
  );
  if (openAppMatch) {
    const appName = openAppMatch[1].trim();
    const packageName = findPackageName(appName);
    if (packageName) {
      return {
        type: "TASK",
        queryId,
        understanding: `Opening ${appName}`,
        confirmRequired: false,
        steps: [
          {
            id: "step-1",
            action: "launch_app",
            packageName,
            description: `Open ${appName}`,
          },
        ],
        confirmationText: `Opened ${appName}`,
      };
    }
  }

  // ── Pattern 2: "call {person/number}" ───────────────────────────
  const callMatch = lower.match(
    /^(?:call|dial|phone|ring|can you call|please call)\s+(.+)$/i
  );
  if (callMatch) {
    const target = callMatch[1].trim();
    // Check if it looks like a phone number
    const isNumber = /^[\d\s\+\-\(\)]+$/.test(target);
    return {
      type: "TASK",
      queryId,
      understanding: `Calling ${target}`,
      confirmRequired: false,
      steps: [
        {
          id: "step-1",
          action: "call_contact",
          description: `Call ${target}`,
          ...(isNumber
            ? { phoneNumber: target }
            : { contactName: target }),
        } as ActionStep,
      ],
      confirmationText: `Calling ${target}`,
    };
  }

  // Not a simple command → let LLM handle it
  return null;
}

function findPackageName(appName: string): string | null {
  const lower = appName.toLowerCase().trim();

  // Direct lookup
  if (APP_NAME_TO_PACKAGE[lower]) {
    return APP_NAME_TO_PACKAGE[lower];
  }

  // Fuzzy match: check if any key contains the app name or vice versa
  for (const [name, pkg] of Object.entries(APP_NAME_TO_PACKAGE)) {
    if (name.includes(lower) || lower.includes(name)) {
      return pkg;
    }
  }

  return null;
}

// ─── Prompt Builder ──────────────────────────────────────────────────

const APP_HINTS = `
APP PACKAGE NAMES (use these exactly):
- Spotify:            com.spotify.music
- WhatsApp:           com.whatsapp
- WhatsApp Business:  com.whatsapp.w4b
- Google Maps:        com.google.android.apps.maps
- Phone/Calls:        com.android.dialer OR com.google.android.dialer
- Clock/Timers:       com.google.android.deskclock
- YouTube:            com.google.android.youtube
- YouTube Music:      com.google.android.apps.youtube.music
- Chrome:             com.android.chrome
- Gmail:              com.google.android.gm
- Google Messages:    com.google.android.apps.messaging
- Camera:             com.android.camera OR com.google.android.GoogleCamera
- Settings:           com.android.settings
- Instagram:          com.instagram.android
- Twitter/X:          com.twitter.android
- Telegram:           org.telegram.messenger
- Google Pay:         com.google.android.apps.nbu.paisa.user
- PhonePe:            com.phonepe.app
- Paytm:              net.one97.paytm
- Uber:               com.ubercab
- Ola:                com.olacabs.customer
- Zomato:             com.application.zomato
- Swiggy:             in.swiggy.android
- Calculator:         com.google.android.calculator
- Gallery/Photos:     com.google.android.apps.photos
- Files:              com.google.android.apps.nbu.files
- Google Keep/Notes:  com.google.android.keep
- Calendar:           com.google.android.calendar
- Contacts:           com.google.android.contacts
- Amazon:             in.amazon.mShop.android.shopping
- Flipkart:           com.flipkart.android
- Netflix:            com.netflix.mediaclient
- Hotstar:            in.startv.hotstar
- Facebook:           com.facebook.katana
- Snapchat:           com.snapchat.android
- LinkedIn:           com.linkedin.android
- Truecaller:         com.truecaller

APP-SPECIFIC UI AUTOMATION HINTS (Use these exact step patterns):

SPOTIFY (Playing a song):
  1. {"id":"s1","action":"launch_app","packageName":"com.spotify.music","description":""}
  2. {"id":"s2","action":"wait","milliseconds":2000,"description":""}
  3. {"id":"s3","action":"tap","target":"Search","description":""} (this activates the search tab)
  4. {"id":"s4","action":"tap","target":"Search","description":""} (this focuses the search bar)
  5. {"id":"s5","action":"type","target":"Search","value":"<song>","description":""}
  6. {"id":"s6","action":"press_enter","target":"Search","description":""}
  7. {"id":"s7","action":"wait","milliseconds":2500,"description":""}
  8. {"id":"s8","action":"tap","target":"<song>","description":""}

YOUTUBE (Playing a video):
  1. {"id":"s1","action":"launch_app","packageName":"com.google.android.youtube","description":""}
  2. {"id":"s2","action":"wait","milliseconds":2000,"description":""}
  3. {"id":"s3","action":"tap","target":"Search","description":""}
  4. {"id":"s4","action":"type","target":"Search YouTube","value":"<video name>","description":""}
  5. {"id":"s5","action":"press_enter","target":"Search YouTube","description":""}
  6. {"id":"s6","action":"wait","milliseconds":2500,"description":""}
  7. {"id":"s7","action":"tap","target":"<video name>","description":""}

WHATSAPP (Sending a message via UI):
  1. {"id":"s1","action":"launch_app","packageName":"com.whatsapp","description":""}
  2. {"id":"s2","action":"wait","milliseconds":1500,"description":""}
  3. {"id":"s3","action":"tap","target":"Search","description":""}
  4. {"id":"s4","action":"type","target":"Search","value":"<contact>","description":""}
  5. {"id":"s5","action":"wait","milliseconds":1500,"description":""}
  6. {"id":"s6","action":"tap","target":"<contact>","description":""}
  7. {"id":"s7","action":"type","target":"Message","value":"<your message>","description":""}
  8. {"id":"s8","action":"tap","target":"Send","description":""}

ALARMS / TIMERS:
  - Timer tab: "Timer" at bottom
  - Add timer: "+" or "Add timer"
  - Start: "Start" button

GOOGLE MAPS:
  - Search field: "Search here"
  - Directions: "Directions" button
  - Start navigation: "Start" button

PHONE CALLS:
  - To call a contact by name → use the "call_contact" action with contactName
  - To call a phone number → use the "call_contact" action with phoneNumber
  - Do NOT try to navigate the dialer UI manually for calling — always use call_contact
  - Example: {"id":"step-1","action":"call_contact","contactName":"Rahul Choudhary","description":"Call Rahul Choudhary"}
  - Example: {"id":"step-1","action":"call_contact","phoneNumber":"+919876543210","description":"Call the number"}

MESSAGING:
  - To send a quick SMS → use "send_message" with contactName/phoneNumber and value (the message text)
  - For WhatsApp messages → use launch_app + tap + type flow as usual

WEB:
  - To open a URL directly → use "open_url" with url field
`;

function buildQuestionPrompt(personaName: string, tone: string, memories: string[]): string {
  const memoryText = memories.length > 0
    ? `\nUser preferences you've learned:\n${memories.map((m) => `- ${m}`).join("\n")}`
    : "";

  return `You are ${personaName}, a helpful AI assistant.
Tone: ${tone}
Answer concisely — your response will be spoken aloud via TTS.
Keep answers under 3 sentences unless asked for more detail.
No markdown, no bullet points, no formatting.
Just plain conversational text.
Spell out numbers as words when they're small (e.g., "twenty five" not "25").
Use short, clear sentences.${memoryText}`;
}

function buildTaskPrompt(
  personaName: string,
  tone: string,
  memories: string[],
  currentApp: string,
  uiTree: string
): string {
  const memoryText = memories.length > 0
    ? `\nUser preferences:\n${memories.map((m) => `- ${m}`).join("\n")}`
    : "";

  return `You are ${personaName}, an AI agent controlling an Android phone.
Tone: ${tone}
You receive a user request and the current screen's UI tree.
Return a JSON action plan to complete the task.

AVAILABLE ACTIONS:
- launch_app: {packageName} — open an app
- tap: {target} — find element by text or content description
- type: {target, value} — clear field and type text
- scroll_down: scroll screen down
- scroll_up: scroll screen up  
- swipe_left: swipe left on screen
- swipe_right: swipe right on screen
- back: press Android back button
- home: press Android home button
- wait: {milliseconds} — wait for app to load
- press_enter: {target} — trigger IMEI enter/search action on an input field
- call_contact: {contactName OR phoneNumber} — directly call a contact or number (PREFERRED for phone calls)
- send_message: {contactName OR phoneNumber, value} — send an SMS message
- open_url: {url} — open a URL in the browser

${APP_HINTS}

RULES:
1. Always launch_app first if the target app isn't the current app
2. Wait at least 2000ms after launching an app before the next step
3. Use exact text visible in the UI tree for tap targets. If the UI tree is not available, use the known text from APP-SPECIFIC hints above.
4. For type actions: tap the field first, then type
5. Keep steps minimal — don't add unnecessary steps
6. If the task involves payment → set confirmRequired: true
7. NEVER set impossible: true for simple tasks like opening apps, making calls, or playing music. Only set impossible if the task truly cannot be done on a phone.
8. Each step needs a unique id like "step-1", "step-2", etc.
9. For phone calls → ALWAYS use call_contact action with contactName field, NOT launch_app + tap
10. For sending SMS → ALWAYS use send_message action
11. For opening URLs → ALWAYS use open_url action
12. For "open X app" → use ONLY a single launch_app step. Nothing else. Example: user says "open spotify" → steps: [{"id":"step-1","action":"launch_app","packageName":"com.spotify.music","description":"Open Spotify"}]
13. For playing music/video → follow the exact step patterns from APP-SPECIFIC hints above
14. If the user mentions an app name you don't have the exact package for, guess the most common package name (e.g., com.app_name.android)

CURRENT SCREEN:
App: ${currentApp}
UI Tree:
${uiTree}
${memoryText}

RESPOND WITH ONLY VALID JSON. NO prose. NO markdown.
Format:
{
  "type": "TASK",
  "understanding": "brief restate of what user wants",
  "impossible": false,
  "impossibleReason": null,
  "confirmRequired": false,
  "steps": [
    {
      "id": "step-1",
      "action": "launch_app",
      "packageName": "com.example.app",
      "description": "Open the app"
    }
  ],
  "confirmationText": "text to speak when done"
}`;
}

// ─── Prompt Injection Detection ──────────────────────────────────────

const INJECTION_PATTERNS = [
  "ignore previous instructions",
  "ignore all previous",
  "system prompt",
  "you are now",
  "new instructions",
  "act as",
  "pretend to be",
  "override your",
  "forget your rules",
  "disregard all",
  "ignore your training",
  "jailbreak",
  "dan mode",
  "developer mode",
];

export function detectInjection(text: string): string | null {
  const lower = text.toLowerCase();

  for (const pattern of INJECTION_PATTERNS) {
    if (lower.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

// ─── Main Planner Function ───────────────────────────────────────────

export async function planAction(
  llm: LLMProvider,
  opts: {
    queryId: string;
    userId: string;
    text: string;
    uiTree?: string;
    currentApp?: string;
    sessionId: string;
    deviceId: string;
  }
): Promise<TaskPlanResult> {
  const { queryId, userId, text, uiTree, currentApp, sessionId, deviceId } = opts;

  // 1. Check for injection in uiTree
  if (uiTree) {
    const injectionPattern = detectInjection(uiTree);
    if (injectionPattern) {
      audit("injection_detected", {
        userId,
        deviceId,
        sessionId,
        data: { app: currentApp, pattern: injectionPattern },
      });
      return {
        type: "ANSWER",
        queryId,
        text: "I detected something suspicious on screen. For safety, I can't process this request right now.",
      };
    }
  }

  // 2. Classify intent
  const intent = classifyIntent(text);

  audit("query_received", {
    userId,
    deviceId,
    sessionId,
    data: { input: text, type: intent.toLowerCase() },
  });

  // 2.5. Try handling simple commands locally (no LLM needed)
  //      This is instant and covers: "open {app}", "call {person}", etc.
  if (intent === "TASK") {
    const localResult = tryHandleLocally(text, queryId);
    if (localResult) {
      audit("local_handled", {
        userId,
        deviceId,
        sessionId,
        data: { input: text, action: localResult.steps?.[0]?.action },
      });
      return localResult;
    }
  }

  // 3. Get persona
  const persona = await getPersona(userId);
  const memories = (persona.memory as Array<{ fact: string; confidence: number }>)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20)
    .map((m) => m.fact);

  // 4. Handle QUESTION
  if (intent === "QUESTION") {
    const systemPrompt = buildQuestionPrompt(persona.name, persona.tone, memories);
    const answer = await llm.complete({ systemPrompt, userMessage: text });

    return {
      type: "ANSWER",
      queryId,
      text: answer.trim(),
    };
  }

  // 5. Handle TASK — permission check
  const permissions = await getUserPermissions(userId);

  // 6. Build task prompt and call LLM
  const systemPrompt = buildTaskPrompt(
    persona.name,
    persona.tone,
    memories,
    currentApp || "com.android.launcher3",
    uiTree || "<no UI tree provided>"
  );

  let rawResponse = await llm.complete({
    systemPrompt,
    userMessage: text,
    temperature: 0.3, // Lower for more deterministic plans
    maxTokens: 4096,
  });

  // 7. Parse response
  let parsed = tryParseTaskResponse(rawResponse);

  // Retry once if parsing failed
  if (!parsed) {
    const retryResponse = await llm.complete({
      systemPrompt: systemPrompt + "\n\nIMPORTANT: Respond with ONLY valid JSON. No other text whatsoever.",
      userMessage: text,
      temperature: 0.2,
    });
    parsed = tryParseTaskResponse(retryResponse);
  }

  if (!parsed) {
    return {
      type: "ANSWER",
      queryId,
      text: "I couldn't plan that action. Could you rephrase your request?",
    };
  }

  // 8. Impossible task
  if (parsed.impossible) {
    return {
      type: "ANSWER",
      queryId,
      text: parsed.impossibleReason || "I can't complete that task right now.",
    };
  }

  // 9. Permission checks on the plan
  if (parsed.steps && parsed.steps.length > 0) {
    for (const step of parsed.steps) {
      if (step.action === "launch_app" && step.packageName) {
        const blockedApps = (permissions.blocked_apps as string[]) || [];
        if (blockedApps.includes(step.packageName)) {
          audit("permission_blocked", {
            userId,
            deviceId,
            sessionId,
            data: { app: step.packageName, action: "launch_app" },
          });
          return {
            type: "ANSWER",
            queryId,
            text: `I can't open that app — it's blocked in your permissions.`,
          };
        }
      }
    }
  }

  // 10. Payment detection → force confirm
  const paymentKeywords = ["pay", "payment", "transfer", "send money", "purchase", "buy"];
  const isPayment = paymentKeywords.some((kw) => text.toLowerCase().includes(kw));
  if (isPayment) {
    parsed.confirmRequired = true;
  }

  return {
    type: "TASK",
    queryId,
    understanding: parsed.understanding,
    confirmRequired: parsed.confirmRequired,
    steps: parsed.steps,
    confirmationText: parsed.confirmationText,
  };
}

// ─── Re-plan after failure ───────────────────────────────────────────

export async function replanFromStep(
  llm: LLMProvider,
  opts: {
    userId: string;
    originalInput: string;
    failedStep: number;
    reason: string;
    currentApp: string;
    uiTree: string;
    previousSteps: ActionStep[];
    sessionId: string;
    deviceId: string;
  }
): Promise<ActionStep[] | null> {
  const { userId, originalInput, failedStep, reason, currentApp, uiTree, previousSteps } = opts;

  const persona = await getPersona(userId);

  const completedSteps = previousSteps.slice(0, failedStep);
  const remainingSteps = previousSteps.slice(failedStep);

  const systemPrompt = `You are ${persona.name}, an AI agent controlling an Android phone.
A task was being executed but step ${failedStep + 1} failed.
You need to re-plan the remaining steps based on the current screen state.

ORIGINAL REQUEST: ${originalInput}

COMPLETED STEPS:
${JSON.stringify(completedSteps, null, 2)}

FAILED STEP:
${JSON.stringify(remainingSteps[0] || {}, null, 2)}

FAILURE REASON: ${reason}

CURRENT SCREEN:
App: ${currentApp}
UI Tree:
${uiTree}

${APP_HINTS}

Re-plan the remaining steps to complete the original task.
Start step IDs from "step-${failedStep + 1}".

RESPOND WITH ONLY A JSON ARRAY of action steps. No other text.
Example: [{"id":"step-3","action":"tap","target":"Search","description":"Tap search"}]`;

  const response = await llm.complete({
    systemPrompt,
    userMessage: `Re-plan remaining steps for: ${originalInput}`,
    temperature: 0.3,
  });

  try {
    const cleaned = cleanJsonResponse(response);
    const steps = JSON.parse(cleaned);
    const validated = z.array(actionStepSchema).parse(steps);
    return validated;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();

  // Remove markdown code fences
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    cleaned = cleaned.slice(firstNewline + 1);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

function tryParseTaskResponse(raw: string): z.infer<typeof taskResponseSchema> | null {
  try {
    const cleaned = cleanJsonResponse(raw);
    const json = JSON.parse(cleaned);
    return taskResponseSchema.parse(json);
  } catch {
    return null;
  }
}
