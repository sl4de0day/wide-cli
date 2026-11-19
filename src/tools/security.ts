import { SecurityScanner, type Finding } from "../security/scanner.js";
import { WideCrawler } from "../security/crawler.js";
import { evaluateHttpInspection } from "../security/inspect.js";
import { fuzzTargetEndpoint } from "../security/fuzzer.js";
import { getPayloadsForType, getAllPayloadTypes } from "../security/payloads.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export const securityScanTool: Tool = {
  definition: {
    name: "run_security_scan",
    description: "Scan workspace code for security vulnerabilities, secrets, and injection flaws using Wide's native SAST engine.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target subdirectory or file to scan (default: entire workspace '.')." },
        rulesPath: { type: "string", description: "Optional path to custom rules.json file." },
        severityFilter: {
          type: "string",
          description: "Minimum severity to report: 'ALL', 'MEDIUM', 'HIGH', or 'CRITICAL'.",
          enum: ["ALL", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
        },
        sca: { type: "boolean", description: "Include OSV dependency vulnerability and reachability scan (default: true)." },
        scanHistory: { type: "boolean", description: "Scan recent git commits for historically leaked credentials (default: false)." },
        sarifPath: { type: "string", description: "Optional file path to write SARIF 2.1.0 JSON report." }
      },
      required: []
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const scanner = new SecurityScanner(context.workingDirectory, params.rulesPath);
      const filter = (params.severityFilter || "ALL") as Finding["severity"] | "ALL";
      const result = await scanner.scanPath(params.path || ".", filter, {
        sca: params.sca !== false,
        scanHistory: Boolean(params.scanHistory),
        sarifPath: params.sarifPath
      });
      const report = scanner.formatCliReport(result);

      return {
        success: true,
        output: report
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Security scan failed: ${err.message}`
      };
    }
  }
};

export const fuzzEndpointTool: Tool = {
  definition: {
    name: "fuzz_endpoint",
    description: "Actively probe a web API endpoint parameter with security payloads to detect or verify vulnerabilities.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target endpoint URL." },
        param: { type: "string", description: "Query, form, JSON, header, cookie, or path parameter to fuzz." },
        payloadType: {
          type: "string",
          description: "Category of payloads to inject.",
          enum: ["sqli", "xss", "ssrf", "traversal", "cmd", "ssti", "idor", "evasion", "smuggling"]
        },
        method: {
          type: "string",
          description: "HTTP method: 'GET', 'POST', 'PUT', 'PATCH', or 'DELETE' (default: 'GET').",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"]
        },
        location: {
          type: "string",
          description: "Parameter placement: 'query', 'form', 'json', 'header', 'cookie', or 'path'.",
          enum: ["query", "form", "json", "header", "cookie", "path"]
        },
        headers: { type: "object", description: "Optional HTTP headers map." },
        compareHeaders: { type: "object", description: "Optional secondary credentials headers for IDOR differential checks." }
      },
      required: ["url", "param", "payloadType"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const report = await fuzzTargetEndpoint(
        params.url,
        params.param,
        params.payloadType,
        params.method || "GET",
        {
          location: params.location,
          headers: params.headers,
          compareHeaders: params.compareHeaders
        }
      );

      const lines: string[] = [
        `Fuzzing Target: ${report.url}`,
        `Tested Parameter: ${report.param}`,
        `Payload Type: ${report.payloadType.toUpperCase()}`,
        `Baseline HTTP: ${report.baselineStatus} (${report.baselineLength} bytes)`,
        `Verdict: ${report.isVulnerable ? "[VULNERABLE]" : "[SAFE / NO ANOMALY]"}`,
        `Summary: ${report.summary}\n`
      ];

      if (report.findings.length > 0) {
        lines.push("Confirmed Findings:");
        for (const f of report.findings) {
          lines.push(`  Payload:   ${f.payload}`);
          lines.push(`  Status:    ${f.statusCode}`);
          lines.push(`  Indicator: ${f.indicator}\n`);
        }
      }

      return {
        success: true,
        output: lines.join("\n")
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Fuzzing failed: ${err.message}`
      };
    }
  }
};

export const generatePayloadsTool: Tool = {
  definition: {
    name: "generate_payloads",
    description: "Generate targeted security test vectors and injection strings for penetration testing.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Payload category: 'sqli', 'xss', 'ssrf', 'traversal', 'cmd', or 'ssti'.",
          enum: ["sqli", "xss", "ssrf", "traversal", "cmd", "ssti"]
        }
      },
      required: ["type"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    const list = getPayloadsForType(params.type);
    if (list.length === 0) {
      return {
        success: false,
        output: "",
        error: `Unknown category '${params.type}'. Available: ${getAllPayloadTypes().join(", ")}`
      };
    }

    return {
      success: true,
      output: `Wide Security Payloads (${params.type.toUpperCase()}):\n\n${list.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
    };
  }
};

export const crawlTargetTool: Tool = {
  definition: {
    name: "crawl_target",
    description: "Crawl a target web application using Wide spider engine (PathTrie, SimHash dedup, JS endpoints, passive headers/secrets/JWT audit).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Seed HTTP or HTTPS URL." },
        maxDepth: { type: "number", description: "Crawl depth limit (default: 3)." },
        maxPages: { type: "number", description: "Maximum pages to crawl (default: 80)." },
        fieldScope: { type: "string", enum: ["rdn", "fqdn", "dn"], description: "Scope matching mode (default: rdn)." },
        allowPrivate: { type: "boolean", description: "Allow private/loopback targets (default: false)." },
        tlsProfile: { type: "string", enum: ["none", "chrome", "firefox", "safari"], description: "Optional TLS impersonation profile." }
      },
      required: ["url"]
    }
  },
  async execute(params): Promise<ToolResult> {
    try {
      const crawler = new WideCrawler();
      const result = await crawler.crawl(String(params.url || ""), {
        maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : 3,
        maxPages: typeof params.maxPages === "number" ? params.maxPages : 80,
        fieldScope: params.fieldScope || "rdn",
        allowPrivate: Boolean(params.allowPrivate),
        tlsProfile: params.tlsProfile || "none",
      });
      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Crawl failed: ${err.message}`,
      };
    }
  }
};

export const inspectHttpTool: Tool = {
  definition: {
    name: "inspect_http_message",
    description: "Inspect an HTTP request/response using RFC 9112 conformance, evasion decoding, lexical SQLi/XSS tokenizers, ReDoS-safe rules, and learning exception drafts.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target HTTP URL or path." },
        method: { type: "string", description: "HTTP method (default GET)." },
        headers: { type: "object", description: "Optional HTTP headers map." },
        body: { type: "string", description: "Optional HTTP body." },
        rawRequest: { type: "string", description: "Optional raw HTTP/1.x wire request for RFC 9112 smuggling check." },
        rawResponse: { type: "string", description: "Optional raw HTTP/1.x wire response for poisoning check." },
        learning: { type: "boolean", description: "Generate dated exception drafts for hits." }
      },
      required: ["url"]
    }
  },
  async execute(params): Promise<ToolResult> {
    try {
      const report = evaluateHttpInspection(
        {
          url: String(params.url || "/"),
          method: String(params.method || "GET"),
          headers: params.headers || {},
          body: typeof params.body === "string" ? params.body : "",
          rawRequest: typeof params.rawRequest === "string" ? params.rawRequest : undefined,
          rawResponse: typeof params.rawResponse === "string" ? params.rawResponse : undefined,
        },
        { learning: Boolean(params.learning) },
      );
      return { success: true, output: JSON.stringify(report, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: `HTTP inspection failed: ${err.message}` };
    }
  }
};
