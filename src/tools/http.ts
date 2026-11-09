import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export const httpRequestTool: Tool = {
  definition: {
    name: "send_http_request",
    description: "Send an HTTP/HTTPS request to test an API endpoint or verify security patches.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL (must include http:// or https://)." },
        method: {
          type: "string",
          description: "HTTP method to use.",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]
        },
        headers: { type: "object", description: "Optional key-value pairs of request headers." },
        body: { type: "string", description: "Optional request body." },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds (default: 15000)." }
      },
      required: ["url"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    const targetUrl = params.url;
    const method = (params.method || "GET").toUpperCase();
    const timeout = params.timeoutMs || 15000;
    const reqHeaders: Record<string, string> = params.headers || {};

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const startTime = Date.now();
      const fetchOptions: RequestInit = {
        method,
        headers: reqHeaders,
        signal: controller.signal
      };

      if (params.body && method !== "GET" && method !== "HEAD") {
        fetchOptions.body = params.body;
      }

      const res = await fetch(targetUrl, fetchOptions);
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      let resText = await res.text();
      if (resText.length > 8000) {
        resText = resText.slice(0, 8000) + "\n... [Body truncated]";
      }

      const resHeaders: string[] = [];
      res.headers.forEach((val, key) => {
        resHeaders.push(`${key}: ${val}`);
      });

      const output = [
        `Status: ${res.status} ${res.statusText}`,
        `Duration: ${durationMs}ms`,
        `Headers:\n${resHeaders.join("\n")}`,
        `Body:\n${resText || "[Empty Body]"}`
      ].join("\n\n");

      return {
        success: true,
        output
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `HTTP request failed: ${err.message}`
      };
    }
  }
};
