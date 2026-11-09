import type { LLMProvider, ChatMessage, ProviderResponse, ToolCall } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

export class ClaudeProvider implements LLMProvider {
  public name = "claude";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = "claude-3-7-sonnet-20250219") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void
  ): Promise<ProviderResponse> {
    if (!this.apiKey) {
      throw new Error("Anthropic API key is not configured. Run 'wide config set-key claude <YOUR_KEY>' or set ANTHROPIC_API_KEY.");
    }

    const systemMsg = messages.find(m => m.role === "system");
    const chatMsgs = messages.filter(m => m.role !== "system");

    const anthropicMessages = chatMsgs.map(m => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.toolCallId || "tool_call",
              content: m.content
            }
          ]
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const contentBlocks: any[] = [];
        if (m.content) {
          contentBlocks.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments
          });
        }
        return { role: "assistant", content: contentBlocks };
      }
      return { role: m.role, content: m.content };
    });

    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object",
        properties: t.parameters.properties,
        required: t.parameters.required
      }
    }));

    const body: any = {
      model: this.model,
      max_tokens: 4096,
      messages: anthropicMessages,
      stream: true
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    if (anthropicTools.length > 0) {
      body.tools = anthropicTools;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error (${res.status}): ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("Could not acquire stream reader from Claude response.");

    const decoder = new TextDecoder();
    let fullText = "";
    const toolCallMap = new Map<number, { id: string; name: string; inputStr: string }>();
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
          const evt = JSON.parse(jsonStr);
          if (evt.type === "content_block_start") {
            if (evt.content_block?.type === "tool_use") {
              toolCallMap.set(evt.index, {
                id: evt.content_block.id,
                name: evt.content_block.name,
                inputStr: ""
              });
            }
          } else if (evt.type === "content_block_delta") {
            if (evt.delta?.type === "text_delta") {
              fullText += evt.delta.text;
              onChunk(evt.delta.text);
            } else if (evt.delta?.type === "input_json_delta") {
              const current = toolCallMap.get(evt.index);
              if (current) {
                current.inputStr += evt.delta.partial_json;
              }
            }
          }
        } catch {
        }
      }
    }

    const collectedToolCalls: ToolCall[] = [];
    toolCallMap.forEach(v => {
      let args = {};
      try {
        args = JSON.parse(v.inputStr || "{}");
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
