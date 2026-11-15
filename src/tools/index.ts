import { readFileTool, writeFileTool, editFileTool } from "./fs.js";
import { listDirTool, searchFilesTool } from "./search.js";
import { runCommandTool } from "./shell.js";
import { securityScanTool, fuzzEndpointTool, generatePayloadsTool } from "./security.js";
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
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export const ALL_TOOLS: Record<string, Tool> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
  search_files: searchFilesTool,
  run_command: runCommandTool,
  run_security_scan: securityScanTool,
  fuzz_endpoint: fuzzEndpointTool,
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

const TOOL_ALIASES: Record<string, string> = {
  browser_fill: "browser_type",
  browser_open_url: "browser_open"
};

export async function executeTool(
  toolName: string,
  params: Record<string, any>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const canonicalName = TOOL_ALIASES[toolName] || toolName;
  const tool = ALL_TOOLS[canonicalName];
  if (!tool) {
    return {
      success: false,
      output: "",
      error: `Unknown tool: '${toolName}'. Available tools: ${Object.keys(ALL_TOOLS).join(", ")}`
    };
  }

  try {
    return await tool.execute(params, context);
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: `Error executing ${toolName}: ${err.message}`
    };
  }
}

export function getToolDefinitions() {
  return Object.values(ALL_TOOLS).map(t => t.definition);
}
