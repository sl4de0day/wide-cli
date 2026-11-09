import pc from "picocolors";
import { configManager } from "../config/index.js";
import { createProvider, type ChatMessage, type LLMProvider } from "../providers/index.js";
import { executeTool, getToolDefinitions } from "../tools/index.js";
import { Spinner } from "../ui/spinner.js";

const SYSTEM_PROMPT = `You are Wide CLI, a security-first autonomous AI coding and web penetration testing agent.
You operate directly in the user's terminal workspace.

Your capabilities:
- Read, write, and edit code files autonomously.
- Run terminal commands to test, build, or verify projects.
- Run Wide's native SAST engine (run_security_scan) to identify vulnerabilities (SQLi, XSS, SSRF, Command Injection, hardcoded secrets, insecure deserialization) in the workspace.
- Keep your answers concise, practical, and action-oriented. Do not produce boilerplate pleasantries.
- Always inspect relevant files before modifying them.
- When fixing security vulnerabilities, provide clean, secure, production-grade solutions.`;

export class Agent {
  private messages: ChatMessage[] = [];
  private provider: LLMProvider;
  private workingDirectory: string;

  constructor(workingDirectory = process.cwd(), provider?: LLMProvider) {
    this.workingDirectory = workingDirectory;
    this.provider = provider || createProvider();
    this.messages.push({
      role: "system",
      content: SYSTEM_PROMPT
    });
  }

  public setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  public clearHistory(): void {
    this.messages = [{
      role: "system",
      content: SYSTEM_PROMPT
    }];
  }

  public async runPrompt(userPrompt: string): Promise<string> {
    const cfg = configManager.get();
    this.messages.push({
      role: "user",
      content: userPrompt
    });

    const tools = getToolDefinitions();
    const spinner = new Spinner("Wide thinking...");
    let iteration = 0;
    let finalAssistantText = "";

    while (iteration < cfg.maxIterations) {
      iteration++;
      spinner.start("Wide thinking...");

      let streamedText = "";
      let response;

      try {
        response = await this.provider.chatStream(
          this.messages,
          tools,
          (chunk) => {
            if (!streamedText) {
              spinner.stop(true);
            }
            streamedText += chunk;
            process.stdout.write(chunk);
          }
        );
      } catch (err: any) {
        spinner.fail(err.message);
        throw err;
      }

      if (streamedText && !streamedText.endsWith("\n")) {
        process.stdout.write("\n");
      }

      finalAssistantText = response.content;

      this.messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls
      });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      for (const tc of response.toolCalls) {
        console.log(`\n${pc.cyan("[TOOL]")} ${pc.bold(tc.name)} ${pc.dim(JSON.stringify(tc.arguments))}`);
        spinner.start(`Executing ${tc.name}...`);

        const result = await executeTool(tc.name, tc.arguments, {
          workingDirectory: this.workingDirectory,
          autoApproveRead: cfg.autoApproveRead,
          autoApproveWrite: cfg.autoApproveWrite,
          autoApproveRun: cfg.autoApproveRun
        });

        if (result.success) {
          spinner.succeed(`${tc.name} succeeded`);
        } else {
          spinner.fail(`${tc.name} failed: ${result.error}`);
        }

        const toolOutput = result.success ? result.output : `ERROR: ${result.error}`;
        
        this.messages.push({
          role: "tool",
          name: tc.name,
          toolCallId: tc.id,
          content: toolOutput
        });
      }
    }

    return finalAssistantText;
  }
}
