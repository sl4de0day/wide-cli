export type ApprovalDecision = "once" | "always" | "deny";
export type CliToolMode = "full" | "code" | "security";

export interface ApprovalRequest {
  tool: string;
  title: string;
  detail: string;
  preview?: string;
  destructive?: boolean;
  sessionKey?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required: string[];
  };
}

export interface ToolExecutionContext {
  workingDirectory: string;
  toolMode?: CliToolMode;
  allowBrowser?: boolean;
  strictValidation?: boolean;
  autoApproveRead?: boolean;
  autoApproveWrite?: boolean;
  autoApproveRun?: boolean;
  signal?: AbortSignal;
  sessionApprovedTools?: Set<string>;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  truncated?: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult>;
}
