// ─── LLM Provider Interface — Pluggable Design ─────────────────────
// Any LLM provider (Gemini, OpenAI, Anthropic, Ollama) must implement
// this interface. Business logic never imports a specific provider.

export interface LLMCompletionParams {
  systemPrompt: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  /** The provider name, e.g. "gemini", "openai" */
  readonly name: string;

  /** The model identifier currently in use */
  readonly model: string;

  /**
   * Send a completion request to the LLM.
   * Returns the raw text response.
   */
  complete(params: LLMCompletionParams): Promise<string>;
}

/**
 * Factory type for creating LLM providers.
 * This lets us swap providers via config without touching business logic.
 */
export type LLMProviderFactory = (apiKey: string, model: string) => LLMProvider;
