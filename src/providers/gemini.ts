import type { LLMProvider, ChatMessage, ProviderResponse, ToolCall } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";
import { fetchWithRetry } from "./retry.js";

export class GeminiProvider implements LLMProvider {
  public name = "gemini";
  private apiKey: string;
  public model: string;

  constructor(apiKey: string, model = "gemini-2.5-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ProviderResponse> {
    if (!this.apiKey) {
      throw new Error("Gemini API key is not configured. Run 'wide config set-key gemini <YOUR_KEY>' or set GEMINI_API_KEY.");
    }

    const systemMsg = messages.find(m => m.role === "system");
    const chatMsgs = messages.filter(m => m.role !== "system");

    const contents: any[] = [];
    for (const m of chatMsgs) {
      if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
        continue;
      }
      if (m.role === "assistant") {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        if (m.toolCalls && m.toolCalls.length > 0) {
          for (const tc of m.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments
              }
            });
          }
        }
        contents.push({ role: "model", parts });
        continue;
      }
      if (m.role === "tool") {
        const part = {
          functionResponse: {
            name: m.name || "tool_result",
            response: { output: m.content }
          }
        };
        const prev = contents[contents.length - 1];
        if (prev && prev.role === "user" && Array.isArray(prev.parts) && prev.parts[0]?.functionResponse) {
          prev.parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
        continue;
      }
      contents.push({ role: "user", parts: [{ text: m.content }] });
    }

    const functionDeclarations = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: "OBJECT",
        properties: t.parameters.properties,
        required: t.parameters.required
      }
    }));

    const body: any = {
      contents,
      generationConfig: {
        temperature: 0.2,
      }
    };

    if (systemMsg) {
      body.systemInstruction = {
        parts: [{ text: systemMsg.content }]
      };
    }

    if (functionDeclarations.length > 0) {
      body.tools = [{ functionDeclarations }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      },
      { maxRetries: 2, timeoutMs: 60000, label: "gemini" }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Could not acquire stream reader from Gemini response.");

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
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const candidate = parsed.candidates?.[0];
            const parts = candidate?.content?.parts || [];

            for (const part of parts) {
              if (part.text) {
                fullText += part.text;
                onChunk(part.text);
              }
              if (part.functionCall) {
                collectedToolCalls.push({
                  id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                  name: part.functionCall.name,
                  arguments: part.functionCall.args || {}
                });
              }
            }
          } catch {
          }
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
