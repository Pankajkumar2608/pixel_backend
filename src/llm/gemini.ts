// ─── Gemini LLM Provider ─────────────────────────────────────────────
// Implements LLMProvider using @google/generative-ai SDK.
// Handles rate limiting (429), retries, and timeout.

import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import type { LLMProvider, LLMCompletionParams } from "./interface";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;

  private genAI: GoogleGenerativeAI;
  private generativeModel: GenerativeModel;

  constructor(apiKey: string, model: string = "gemini-2.0-flash-exp") {
    this.model = model;
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.generativeModel = this.genAI.getGenerativeModel({ model });
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const { systemPrompt, userMessage, temperature = 0.7, maxTokens = 4096 } = params;

    const requestConfig = {
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    const model = this.genAI.getGenerativeModel({
      model: this.model,
      ...requestConfig,
    });

    // Attempt with retry on rate limit
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await Promise.race([
          model.generateContent(userMessage),
          this.timeout(15000),
        ]);

        if (!result || !("response" in result)) {
          throw new GeminiError("Request timed out", "TIMEOUT");
        }

        const response = result.response;
        const text = response.text();

        if (!text) {
          throw new GeminiError("Empty response from Gemini", "EMPTY_RESPONSE");
        }

        return text;
      } catch (err: unknown) {
        if (err instanceof GeminiError) throw err;

        const error = err as { status?: number; message?: string };

        // Rate limited — wait and retry once
        if (error.status === 429 && attempt === 0) {
          console.warn("  ⚠️  Gemini rate limited, retrying in 2s...");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        // API key invalid
        if (error.status === 401 || error.status === 403) {
          throw new GeminiError(
            "Invalid Gemini API key. Check your config.",
            "AUTH_ERROR"
          );
        }

        // All other errors
        const msg = error.message || String(err);
        throw new GeminiError(`Gemini API error: ${msg}`, "API_ERROR");
      }
    }

    throw new GeminiError("Gemini is busy, please try again in a moment.", "RATE_LIMITED");
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new GeminiError("Request timed out", "TIMEOUT")), ms);
    });
  }
}

export class GeminiError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
  }
}

/** Factory function — matches LLMProviderFactory type */
export function createGeminiProvider(apiKey: string, model: string): LLMProvider {
  return new GeminiProvider(apiKey, model);
}
