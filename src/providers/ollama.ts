import type { LLMProvider, ChatMessage, ProviderResponse, ToolCall } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

export class OllamaProvider implements LLMProvider {
  public name = "ollama";
  private baseUrl: string;
  private model: string;

  constructor(baseUrl = "http://localhost:11434", model = "deepseek-r1:7b") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void
  ): Promise<ProviderResponse> {
    const formattedMessages = messages.map(m => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, name: m.name };
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
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (err: any) {
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

    return {
      content: fullText,
      toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
    };
  }
}
