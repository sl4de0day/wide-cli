import type { ToolDefinition } from "../tools/types.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ProviderEvent {
  type: "thinking" | "tool_start" | "tool_end" | "status" | "usage";
  label?: string;
  detail?: string;
  success?: boolean;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface LLMProvider {
  name: string;
  model: string;
  chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: ProviderEvent) => void
  ): Promise<ProviderResponse>;
}
