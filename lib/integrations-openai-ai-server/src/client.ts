import OpenAI from "openai";

/**
 * Lazy client: importing this module never throws, so the API server can boot
 * without the AI integration. AI features call getOpenAI() and report
 * "AI unavailable" when it is not configured.
 */
export function isAIConfigured(): boolean {
  return Boolean(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
}

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!isAIConfigured()) {
    throw new Error("AI unavailable: AI_INTEGRATIONS_OPENAI_BASE_URL / AI_INTEGRATIONS_OPENAI_API_KEY are not set");
  }
  client ??= new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
  return client;
}

/** Back-compat proxy so existing `openai.chat...` call sites keep working lazily. */
export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop, receiver) {
    return Reflect.get(getOpenAI() as object, prop, receiver);
  },
});
