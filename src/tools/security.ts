import { SecurityScanner, type Finding } from "../security/scanner.js";
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
        }
      },
      required: []
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const scanner = new SecurityScanner(context.workingDirectory, params.rulesPath);
      const filter = (params.severityFilter || "ALL") as Finding["severity"] | "ALL";
      const result = await scanner.scanPath(params.path || ".", filter);
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
        param: { type: "string", description: "Query or body parameter to fuzz." },
        payloadType: {
          type: "string",
          description: "Category of payloads to inject.",
          enum: ["sqli", "xss", "ssrf", "traversal", "cmd", "ssti"]
        },
        method: {
          type: "string",
          description: "HTTP method: 'GET' or 'POST' (default: 'GET').",
          enum: ["GET", "POST"]
        }
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
        params.method || "GET"
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
