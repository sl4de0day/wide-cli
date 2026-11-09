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
  autoApproveRead?: boolean;
  autoApproveWrite?: boolean;
  autoApproveRun?: boolean;
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
