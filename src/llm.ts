export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AiTextResult {
  response?: unknown;
  choices?: { message?: { content?: string } }[];
}

/** One-shot completion (used by the workflow). */
export async function completeText(
  env: Env,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const res = (await env.AI.run(MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 500,
    temperature: opts.temperature ?? 0.1,
  })) as AiTextResult;
  const raw = res.response ?? res.choices?.[0]?.message?.content ?? "";
  // JSON-mode style responses can already be objects.
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/** Pull the first JSON object out of a model reply (models like to add prose or code fences). */
export function extractJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Streaming completion (used by chat). Yields text tokens as they arrive. */
export async function* streamText(env: Env, messages: ChatMessage[]): AsyncGenerator<string> {
  const stream = (await env.AI.run(MODEL, {
    messages,
    stream: true,
    max_tokens: 900,
    temperature: 0.3,
  })) as ReadableStream<Uint8Array>;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data) as AiTextResult & { choices?: { delta?: { content?: string } }[] };
          const token = (json.response as string | undefined) ?? json.choices?.[0]?.delta?.content;
          if (token) yield token;
        } catch {
          // ignore partial / non-JSON keep-alive lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
