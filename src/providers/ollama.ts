import type { LLMProvider, ChatMessage, ProviderResponse, ToolCall } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";
import { fetchWithRetry } from "./retry.js";

export interface OllamaProbeResult {
  reachable: boolean;
  models: string[];
}

export async function listOllamaModels(baseUrl = "http://localhost:11434"): Promise<OllamaProbeResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  timer.unref?.();
  try {
    const res = await fetch(`${cleanUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { reachable: true, models: [] };
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models || []).map((m) => String(m.name || "")).filter(Boolean);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaProvider implements LLMProvider {
  public name = "ollama";
  private baseUrl: string;
  public model: string;

  constructor(baseUrl = "http://localhost:11434", model = "deepseek-r1:7b") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ProviderResponse> {
    const formattedMessages = messages.map(m => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, name: m.name };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || "",
          tool_calls: m.toolCalls.map(tc => ({
            function: {
              name: tc.name,
              arguments: tc.arguments
            }
          }))
        };
      }
      return { role: m.role, content: m.content };
    });

    const formattedTools = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    const body: any = {
      model: this.model,
      messages: formattedMessages,
      stream: true,
      options: {
        temperature: 0.2
      }
    };

    if (formattedTools.length > 0) {
      body.tools = formattedTools;
    }

    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal
        },
        { maxRetries: 1, timeoutMs: 120000, label: "ollama" }
      );
    } catch (err: any) {
      if (err?.name === "AbortError" || signal?.aborted) {
        const abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      throw new Error(`Failed to connect to Ollama at ${this.baseUrl}: ${err.message}. Is Ollama running?`);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama error (${response.status}): ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Could not acquire stream reader from Ollama.");

    const decoder = new TextDecoder();
    let fullText = "";
    const collectedToolCalls: ToolCall[] = [];
    let buffer = "";

    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const msg = parsed.message;
            if (msg?.content) {
              fullText += msg.content;
              onChunk(msg.content);
            }
            if (msg?.tool_calls) {
              for (const tc of msg.tool_calls) {
                collectedToolCalls.push({
                  id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                  name: tc.function.name,
                  arguments: tc.function.arguments || {}
                });
              }
            }
          } catch {
          }
        }
      }
      const tail = buffer.trim();
      if (tail) {
        try {
          const parsed = JSON.parse(tail);
          const msg = parsed.message;
          if (msg?.content) {
            fullText += msg.content;
            onChunk(msg.content);
          }
          if (msg?.tool_calls) {
            for (const tc of msg.tool_calls) {
              collectedToolCalls.push({
                id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                name: tc.function.name,
                arguments: tc.function.arguments || {}
              });
            }
          }
        } catch {
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) {
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    return {
      content: fullText,
      toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
    };
  }
}
