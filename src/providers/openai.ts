import type { LLMProvider, ChatMessage, ProviderResponse, ToolCall } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

export class OpenAICompatibleProvider implements LLMProvider {
  public name: string;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(
    name: string,
    apiKey: string,
    model: string,
    baseUrl = "https://api.openai.com/v1"
  ) {
    this.name = name;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void
  ): Promise<ProviderResponse> {
    if (!this.apiKey) {
      throw new Error(`${this.name.toUpperCase()} API key is not configured. Run 'wide config set-key ${this.name} <YOUR_KEY>'.`);
    }

    const openAiMessages = messages.map(m => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || "tool_call",
          content: m.content
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          }))
        };
      }
      return { role: m.role, content: m.content };
    });

    const openAiTools = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    const body: any = {
      model: this.model,
      messages: openAiMessages,
      stream: true,
      temperature: 0.2
    };

    if (openAiTools.length > 0) {
      body.tools = openAiTools;
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.name} API error (${res.status}): ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`Could not acquire stream reader from ${this.name}.`);

    const decoder = new TextDecoder();
    let fullText = "";
    const toolCallAccumulators = new Map<number, { id: string; name: string; argsStr: string }>();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            onChunk(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, {
                  id: tc.id || `call_${Date.now()}_${idx}`,
                  name: tc.function?.name || "",
                  argsStr: tc.function?.arguments || ""
                });
              } else {
                const acc = toolCallAccumulators.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.argsStr += tc.function.arguments;
              }
            }
          }
        } catch {
        }
      }
    }

    const collectedToolCalls: ToolCall[] = [];
    toolCallAccumulators.forEach(v => {
      let args = {};
      try {
        args = JSON.parse(v.argsStr || "{}");
      } catch {
      }
      collectedToolCalls.push({
        id: v.id,
        name: v.name,
        arguments: args
      });
    });

    return {
      content: fullText,
      toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
    };
  }
}
