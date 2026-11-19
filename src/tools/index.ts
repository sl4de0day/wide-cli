import { readFileTool, readDocumentTool, writeFileTool, editFileTool } from "./fs.js";
import { listDirTool, searchFilesTool } from "./search.js";
import { runCommandTool } from "./shell.js";
import { securityScanTool, fuzzEndpointTool, generatePayloadsTool, crawlTargetTool, inspectHttpTool } from "./security.js";
import { httpRequestTool } from "./http.js";
import { gitTool } from "./git.js";
import { dbAuditTool, dbExportTool, dbInspectSchemaTool, dbListTool, dbQueryTool } from "./db.js";
import {
  browserOpenTool,
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserPressTool,
  browserHoverTool,
  browserSelectTool,
  browserScrollTool,
  browserWaitTool,
  browserExtractTool,
  browserScreenshotTool,
  browserConsoleTool,
  browserCookiesTool,
  browserEvalTool,
  browserExportHarTool,
  browserCloseTool
} from "./browser.js";
import type { CliToolMode, Tool, ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";

export const ALL_TOOLS: Record<string, Tool> = {
  read_file: readFileTool,
  read_document: readDocumentTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
  search_files: searchFilesTool,
  run_command: runCommandTool,
  run_security_scan: securityScanTool,
  fuzz_endpoint: fuzzEndpointTool,
  crawl_target: crawlTargetTool,
  inspect_http_message: inspectHttpTool,
  generate_payloads: generatePayloadsTool,
  send_http_request: httpRequestTool,
  git_inspection: gitTool,
  db_list: dbListTool,
  db_inspect_schema: dbInspectSchemaTool,
  db_audit: dbAuditTool,
  db_export: dbExportTool,
  db_query: dbQueryTool,
  browser_open: browserOpenTool,
  browser_navigate: browserNavigateTool,
  browser_snapshot: browserSnapshotTool,
  browser_click: browserClickTool,
  browser_type: browserTypeTool,
  browser_press: browserPressTool,
  browser_hover: browserHoverTool,
  browser_select: browserSelectTool,
  browser_scroll: browserScrollTool,
  browser_wait: browserWaitTool,
  browser_extract: browserExtractTool,
  browser_screenshot: browserScreenshotTool,
  browser_console: browserConsoleTool,
  browser_cookies: browserCookiesTool,
  browser_eval: browserEvalTool,
  browser_export_har: browserExportHarTool,
  browser_close: browserCloseTool,
};

const CLI_SECURITY_TOOLS = new Set<string>([
  "send_http_request",
  "run_security_scan",
  "fuzz_endpoint",
  "crawl_target",
  "inspect_http_message",
  "generate_payloads",
]);

const CLI_CODE_ONLY_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
  "git_inspection",
]);

const CLI_EMPTY_STRING_ALLOWED = new Set<string>(["content", "replacement"]);

export function normalizeToolMode(mode?: string | null): CliToolMode {
  const m = String(mode ?? "full").trim().toLowerCase();
  if (m === "code" || m === "security" || m === "full") return m;
  return "full";
}

export function isToolAllowedInMode(
  toolName: string,
  opts: { toolMode?: CliToolMode | string; allowBrowser?: boolean } = {},
): boolean {
  if (toolName.startsWith("browser_") && opts.allowBrowser === false) return false;
  const mode = normalizeToolMode(opts.toolMode);
  if (mode === "code" && CLI_SECURITY_TOOLS.has(toolName)) return false;
  if (mode === "security" && CLI_CODE_ONLY_TOOLS.has(toolName)) return false;
  return true;
}

export function validateToolCallArgs(
  rawName: unknown,
  rawParams: unknown,
  opts: { toolMode?: CliToolMode | string; allowBrowser?: boolean } = {},
): { ok: true; name: string; params: Record<string, unknown> } | { ok: false; error: string } {
  const name = String(rawName ?? "").trim();
  const mode = normalizeToolMode(opts.toolMode);
  const allowBrowser = opts.allowBrowser !== false;
  if (!name) {
    return { ok: false, error: "UNKNOWN_TOOL: Empty tool name." };
  }
  const tool = ALL_TOOLS[name];
  if (!tool) {
    const enabled = getToolDefinitions({ toolMode: mode, allowBrowser }).map((d) => d.name);
    return {
      ok: false,
      error: `UNKNOWN_TOOL: "${name}" does not exist. Enabled tools (${mode}): ${enabled.join(", ")}.`,
    };
  }
  if (!isToolAllowedInMode(name, { toolMode: mode, allowBrowser })) {
    const reason =
      name.startsWith("browser_") && !allowBrowser
        ? `Tool "${name}" requires Browser mode to be enabled, but --no-browser / browser OFF is active.`
        : `Tool "${name}" is disabled in "${mode}" mode.`;
    return { ok: false, error: `TOOL_DISABLED_IN_MODE: ${reason}` };
  }
  if (rawParams === null || rawParams === undefined || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return { ok: false, error: `SCHEMA_VALIDATION_ERROR for "${name}": Tool arguments must be a strict JSON object.` };
  }

  const input = rawParams as Record<string, unknown>;
  const defProps = tool.definition.parameters.properties ?? {};
  const required = Array.isArray(tool.definition.parameters.required) ? tool.definition.parameters.required : [];
  const issues: string[] = [];

  for (const key of Object.keys(input)) {
    if (!(key in defProps)) {
      issues.push(`Unrecognized property "${key}"`);
    }
  }
  for (const reqKey of required) {
    const val = input[reqKey];
    const propType = defProps[reqKey]?.type;
    if (val === undefined || val === null) {
      issues.push(`${reqKey}: required field missing`);
    } else if (propType === "string" && (typeof val !== "string" || (val.trim() === "" && !CLI_EMPTY_STRING_ALLOWED.has(reqKey)))) {
      issues.push(`${reqKey}: must be a non-empty string`);
    }
  }
  for (const [key, val] of Object.entries(input)) {
    if (val === undefined) continue;
    const spec = defProps[key];
    if (!spec) continue;
    if (spec.type === "string") {
      if (typeof val !== "string") {
        issues.push(`${key}: expected string, received ${typeof val}`);
      } else if (Array.isArray(spec.enum) && !spec.enum.includes(val)) {
        issues.push(`${key}: expected one of [${spec.enum.join(", ")}]`);
      }
    } else if (spec.type === "number" || spec.type === "integer") {
      if (typeof val !== "number" || !Number.isFinite(val)) {
        issues.push(`${key}: expected finite number`);
      }
    } else if (spec.type === "boolean") {
      if (typeof val !== "boolean") {
        issues.push(`${key}: expected boolean`);
      }
    } else if (spec.type === "array") {
      if (!Array.isArray(val)) {
        issues.push(`${key}: expected array`);
      }
    } else if (spec.type === "object") {
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        issues.push(`${key}: expected object`);
      }
    }
  }

  if (issues.length > 0) {
    const expectedFields = Object.entries(defProps)
      .map(([k, v]) => `${k}${required.includes(k) ? " (required)" : " (optional)"}: ${v?.type || "any"}`)
      .join(", ");
    return {
      ok: false,
      error: `SCHEMA_VALIDATION_ERROR for "${name}": ${issues.join("; ")}. Expected strict object with properties: { ${expectedFields} }. Retry using exact schema property names.`,
    };
  }
  return { ok: true, name, params: input };
}

export async function executeTool(
  toolName: string,
  params: Record<string, any>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const check = validateToolCallArgs(toolName, params, {
    toolMode: context.toolMode,
    allowBrowser: context.allowBrowser,
  });
  if (!check.ok) {
    return {
      success: false,
      output: "",
      error: check.error,
    };
  }
  const tool = ALL_TOOLS[check.name];

  try {
    return await tool.execute(check.params, context);
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: `Error executing ${check.name}: ${err.message}`
    };
  }
}

export function getToolDefinitions(
  opts: { toolMode?: CliToolMode | string; allowBrowser?: boolean } = {},
): ToolDefinition[] {
  return Object.values(ALL_TOOLS)
    .filter((t) => isToolAllowedInMode(t.definition.name, opts))
    .map((t) => t.definition);
}
