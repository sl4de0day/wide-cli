export type ApprovalDecision = "once" | "always" | "deny";
export type ApprovalOutcome =
  | ApprovalDecision
  | {
      decision: ApprovalDecision;
      pattern?: string;
      feedback?: string;
    };

export type CliToolMode = "full" | "code" | "security";
export type PermissionProfile = "ask" | "accept-edits" | "plan" | "auto";

export interface ApprovalRequest {
  tool: string;
  title: string;
  detail: string;
  preview?: string;
  destructive?: boolean;
  sessionKey?: string;
  suggestedPattern?: string;
}

export interface FileChangeSnapshot {
  filePath: string;
  relPath: string;
  existedBefore: boolean;
  beforeContent: string;
  afterContent: string;
  tool: string;
  added: number;
  removed: number;
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
  permissionProfile?: PermissionProfile;
  allowBrowser?: boolean;
  strictValidation?: boolean;
  autoApproveRead?: boolean;
  autoApproveWrite?: boolean;
  autoApproveRun?: boolean;
  signal?: AbortSignal;
  sessionApprovedTools?: Set<string>;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  onOutputLine?: (line: string, stream: "stdout" | "stderr") => void;
  onFileChange?: (snapshot: FileChangeSnapshot) => void;
  evaluatePermission?: (tool: string, target: string) => "allow" | "ask" | "deny" | null;
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

export function normalizeApprovalOutcome(outcome: ApprovalOutcome): {
  decision: ApprovalDecision;
  pattern?: string;
  feedback?: string;
} {
  if (typeof outcome === "string") {
    return { decision: outcome };
  }
  return outcome;
}
