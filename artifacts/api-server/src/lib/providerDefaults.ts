/**
 * Default API base URLs per provider type, used only when an endpoint has no
 * explicit Base URL (and no host/port) of its own. Keeping this in a leaf
 * module (no imports) lets every request-building path — agent completions,
 * model listing, and the bot's tool-chat — resolve the same default without
 * creating import cycles.
 *
 * OpenRouter must NOT inherit the OpenAI default: a blank Base URL would
 * otherwise send an OpenRouter key + `deepseek/...` model name to OpenAI,
 * which rejects it (402/401). Route OpenRouter to its own API instead.
 */
export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
export const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";

/**
 * Default base URL for an OpenAI-compatible provider type (openai,
 * openai_compatible, openrouter, azure_openai). Returns OpenRouter's API for
 * `openrouter`, otherwise the OpenAI default.
 */
export function defaultOpenAiCompatibleBase(providerType: string): string {
  return providerType === "openrouter"
    ? OPENROUTER_DEFAULT_BASE
    : OPENAI_DEFAULT_BASE;
}
