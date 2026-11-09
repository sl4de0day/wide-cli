import { readFileTool, writeFileTool, editFileTool } from "./fs.js";
import { listDirTool, searchFilesTool } from "./search.js";
import { runCommandTool } from "./shell.js";
import { securityScanTool, fuzzEndpointTool, generatePayloadsTool } from "./security.js";
import { httpRequestTool } from "./http.js";
import { gitTool } from "./git.js";
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
};

export async function executeTool(
  toolName: string,
  params: Record<string, any>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const tool = ALL_TOOLS[toolName];
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
