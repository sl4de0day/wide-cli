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

    const systemMsg = messages[0]?.role === "system" ? messages[0] : undefined;
    const body = messages.filter((m, i) => !(i === 0 && m.role === "system") && m.role !== "system");
    if (body.length === 0) return systemMsg ? [systemMsg] : [];

    let sliceStart = Math.max(0, body.length - 10);
    while (sliceStart > 0 && body[sliceStart].role === "tool") {
      sliceStart--;
    }
    if (body[sliceStart]?.role === "assistant" && sliceStart > 0 && body[sliceStart - 1].role === "user") {
      sliceStart--;
    }
    const recentMessages = body.slice(sliceStart);
    const initialUserMsg = body.find((m) => m.role === "user");

    const compacted: ChatMessage[] = [];
    const compactionNote = "[Context Compaction] Earlier tool interactions were summarized to preserve context window limits. Continue with current objective.";
    if (systemMsg) {
      compacted.push({
        role: "system",
        content: systemMsg.content.includes("[Context Compaction]")
          ? systemMsg.content
          : `${systemMsg.content}\n\n${compactionNote}`
      });
    } else {
      compacted.push({ role: "system", content: compactionNote });
    }

    if (initialUserMsg && sliceStart > 0 && !recentMessages.includes(initialUserMsg)) {
      if (recentMessages[0]?.role === "user") {
        recentMessages[0] = {
          ...recentMessages[0],
          content: `[Initial Request]\n${initialUserMsg.content}\n\n[Latest Request]\n${recentMessages[0].content}`
        };
      } else {
        compacted.push(initialUserMsg);
      }
    } else if (recentMessages[0]?.role === "assistant") {
      compacted.push({ role: "user", content: "Continue with the current objective." });
    }

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
