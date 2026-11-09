import type { ChatMessage } from "../providers/types.js";

export class ContextManager {
  private maxCharacters: number;

  constructor(maxCharacters = 40000) {
    this.maxCharacters = maxCharacters;
  }

  public compactMessages(messages: ChatMessage[]): ChatMessage[] {
    const totalChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
    if (totalChars <= this.maxCharacters && messages.length <= 20) {
      return messages;
    }

    const systemMsg = messages[0];
    const initialUserMsg = messages.find((m, i) => i > 0 && m.role === "user");
    const recentMessages = messages.slice(-10);

    const compacted: ChatMessage[] = [];
    if (systemMsg) compacted.push(systemMsg);
    if (initialUserMsg && !recentMessages.includes(initialUserMsg)) {
      compacted.push(initialUserMsg);
    }

    compacted.push({
      role: "system",
      content: "[Context Compaction] Earlier tool interactions were summarized to preserve context window limits. Continue with current objective."
    });

    for (const msg of recentMessages) {
      if (msg.role === "tool" && msg.content.length > 2000) {
        compacted.push({
          ...msg,
          content: msg.content.slice(0, 2000) + "\n... [Output compacted]"
        });
      } else {
        compacted.push(msg);
      }
    }

    return compacted;
  }
}
