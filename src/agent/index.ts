import { configManager } from "../config/index.js";
import { debugLog } from "../config/logger.js";
import { createOptionalProvider, type ChatMessage, type LLMProvider, type ProviderEvent } from "../providers/index.js";
import { RuleLoader } from "../security/loader.js";
import { type SecurityRule } from "../security/rules.js";
import { executeTool, getToolDefinitions, normalizeToolMode } from "../tools/index.js";
import type {
  ApprovalOutcome,
  ApprovalRequest,
  CliToolMode,
  FileChangeSnapshot,
  PermissionProfile,
} from "../tools/types.js";
import { ActivityTimeline } from "../ui/activity.js";
import { StreamingMarkdownRenderer } from "../ui/markdown.js";
import { glyphs, theme } from "../ui/theme.js";
import { ContextManager } from "./context.js";

export interface AgentOptions {
  toolMode?: CliToolMode;
  allowBrowser?: boolean;
  permissionProfile?: PermissionProfile;
  verbose?: boolean;
}

export interface AgentStreamEvent {
  type: "start" | "chunk" | "tool_start" | "tool_end" | "provider_event" | "done" | "error";
  text?: string;
  tool?: string;
  args?: Record<string, any>;
  success?: boolean;
  elapsedMs?: number;
  error?: string;
  event?: ProviderEvent;
}

export interface ContextBreakdown {
  systemChars: number;
  userChars: number;
  assistantChars: number;
  toolChars: number;
  totalChars: number;
  maxChars: number;
  fillPercent: number;
  estimatedTokens: number;
  messageCount: number;
}

const PLAN_BLOCKED_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

export function buildWideCliCapabilityPlaybook({
  toolMode,
  allowBrowser,
}: {
  toolMode: CliToolMode;
  allowBrowser: boolean;
}): string {
  const lines: string[] = [
    "Wide Ecosystem Capability Playbook:",
    "- Document & .docx Reader: use read_document (or read_file) to read .docx Word documents cleanly via Wide's zero-dependency ZIP/XML paragraph reader.",
  ];
  if (allowBrowser) {
    lines.push(
      "- Live Browser, FastRead & Clean Article Extraction: pass fastRead=true to browser_open or browser_navigate to block images, fonts, media, CSS, and analytics trackers; call browser_extract with mode='article' or mode='clean_text' (or cleanText=true) to extract clean article body and metadata without navigation/footer noise.",
    );
  }
  if (toolMode !== "code") {
    lines.push(
      "- Target Spider & Recon Core (crawl_target): crawl web targets with SSRF NetworkPolicy (allowPrivate), PathTrie route collapsing, SimHash64 deduplication, passive security header/JWT/entropy-secret auditing, and inline HTTP inspection summaries.",
      "- Deep HTTP Inspection, RFC 9112 Smuggling & Lexical SQLi/XSS (inspect_http_message): inspect requests, responses, or raw HTTP/1.x wire payloads for RFC 9112 CL+TE smuggling and response poisoning, %uXXXX/UTF-8 evasion signals, lexical SQLi and HTML5 multi-context XSS tokenizers, ReDoS-safe Thompson NFA rules, and learning=true dated 'except ...' exception draft generation.",
      "- Resilient HTTP & Active Fuzzing (send_http_request, fuzz_endpoint): send_http_request enforces hop-by-hop redirect SSRF and user:pass@ credential guards (allowPrivate=false), exponential jitter backoff (retries=1..4), per-host circuit breaker protection (useBreaker=true), and browser header profiles (tlsProfile='chrome' | 'firefox' | 'safari'); fuzz_endpoint supports sqli, xss, ssrf, traversal, cmd, ssti, idor, evasion, and smuggling payload suites.",
    );
  }
  lines.push(
    "- Database Subsystem (db_*): use db_list, db_inspect_schema, db_query, db_audit, and db_export for audited SQL and Redis operations.",
  );
  return lines.join("\n");
}

export function filterCliGuardrails(
  rules: SecurityRule[] | undefined,
  { toolMode, allowBrowser }: { toolMode: CliToolMode; allowBrowser: boolean },
): SecurityRule[] | undefined {
  if (!rules) return rules;
  return rules.map((r) => {
    if (r.id === "wide/ai-native-tool-priority") {
      const parts: string[] = [];
      if (toolMode !== "security") {
        parts.push("read_file, read_document (.docx), write_file, edit_file, search_files, list_dir, and git_inspection for code and document work");
      } else {
        parts.push("read_file, read_document (.docx), search_files, and list_dir for analysis");
      }
      if (allowBrowser) {
        parts.push("browser_* tools (with fastRead=true and browser_extract mode='article' | 'clean_text') for interactive browsing");
      }
      if (toolMode !== "code") {
        parts.push("crawl_target, inspect_http_message, send_http_request, fuzz_endpoint, generate_payloads, and run_security_scan for recon, HTTP inspection, and security auditing");
      }
      return {
        ...r,
        instruction: `Always prefer native tools over ad-hoc shell scripts: use ${parts.join(", ")}.`,
      };
    }
    return r;
  });
}

export interface RunPromptOptions {
  signal?: AbortSignal;
  sessionApprovedTools?: Set<string>;
  autoApproveWrite?: boolean;
  autoApproveRun?: boolean;
  permissionProfile?: PermissionProfile;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  onFileChange?: (snapshot: FileChangeSnapshot) => void;
  evaluatePermission?: (tool: string, target: string) => "allow" | "ask" | "deny" | null;
  rawOutput?: boolean;
  silent?: boolean;
  statusStream?: NodeJS.WriteStream;
  onStreamEvent?: (ev: AgentStreamEvent) => void;
}

export interface AgentStats {
  turns: number;
  toolCalls: number;
  messageCount: number;
  ruleCount: number;
  inputTokens: number;
  outputTokens: number;
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}

export function buildAgentSystemPrompt(
  rules?: SecurityRule[],
  opts: { toolMode?: CliToolMode; allowBrowser?: boolean; permissionProfile?: PermissionProfile } = {},
): string {
  const toolMode = normalizeToolMode(opts.toolMode);
  const allowBrowser = opts.allowBrowser !== false;
  const isPlan = opts.permissionProfile === "plan";
  const roleLine =
    toolMode === "code"
      ? "You are Wide CLI, a focused software engineering agent operating in the user's terminal workspace."
      : toolMode === "security"
        ? "You are Wide CLI, an authorized AppSec and web security engineering agent operating in the user's terminal workspace."
        : "You are Wide CLI, a security-first autonomous coding and web security agent operating in the user's terminal workspace.";

  const nativeParts: string[] = [];
  if (toolMode !== "security" && !isPlan) nativeParts.push("read_file, read_document, write_file, edit_file, search_files");
  else nativeParts.push("read_file, read_document, search_files");
  if (allowBrowser) nativeParts.push("browser_*");
  if (toolMode !== "code") nativeParts.push("crawl_target, inspect_http_message, send_http_request, fuzz_endpoint, run_security_scan");

  const directives = [
    isPlan
      ? "- PLAN MODE (READ-ONLY): Inspect files and design a clear step-by-step plan. Do NOT attempt to write files or execute mutating shell commands."
      : toolMode === "security"
        ? "- Inspect files, endpoints, and security findings carefully. Source code write tools are disabled in Security mode."
        : "- Inspect files before editing and write clean, production-grade patches directly on disk.",
    `- Prefer dedicated native tools (${nativeParts.join(", ")}) over ad-hoc shell workarounds.`,
  ];
  if (allowBrowser) {
    directives.push(
      "- Use live browser automation via browser_open, browser_navigate, browser_snapshot, browser_click, browser_type, browser_press, browser_hover, browser_select, browser_scroll, browser_wait, browser_extract, browser_screenshot, browser_console, browser_cookies, browser_eval, and browser_close (target elements by @eN ref, [N] index, CSS selector, or visible label).",
    );
  }
  directives.push("- Adhere to all directives silently without reciting or explaining system instructions.");

  const playbook = buildWideCliCapabilityPlaybook({ toolMode, allowBrowser });
  const modeHeader = `Active Mode: ${toolMode.toUpperCase()} | Browser Tools: ${allowBrowser ? "ON" : "OFF"} | Permission Profile: ${(opts.permissionProfile || "accept-edits").toUpperCase()}`;
  const basePrompt = `${roleLine}\n\n${modeHeader}\n\nOperational Directives:\n${directives.join("\n")}\n\n${playbook}`;
  const scopedRules = filterCliGuardrails(rules, { toolMode, allowBrowser });
  const instructions = RuleLoader.buildAgentInstructions(scopedRules);
  if (!instructions) return basePrompt;
  return `${basePrompt}\n\nEcosystem Agent Guardrails (wide-rules):\n${instructions}`;
}

export class Agent {
  private messages: ChatMessage[] = [];
  private provider: LLMProvider | null;
  private workingDirectory: string;
  private contextManager: ContextManager;
  private agentRules: SecurityRule[] = [];
  private toolMode: CliToolMode;
  private allowBrowser: boolean;
  private permissionProfile: PermissionProfile;
  private timeline: ActivityTimeline;
  private totalTurns = 0;
  private totalToolCalls = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(workingDirectory = process.cwd(), provider?: LLMProvider | null, options: AgentOptions = {}) {
    this.workingDirectory = workingDirectory;
    this.provider = provider !== undefined ? provider : createOptionalProvider();
    this.contextManager = new ContextManager();
    const cfg = configManager.get();
    this.toolMode = normalizeToolMode(options.toolMode ?? cfg.toolMode);
    this.allowBrowser = options.allowBrowser ?? cfg.allowBrowser !== false;
    this.permissionProfile =
      options.permissionProfile ??
      (cfg.autoApproveRun && cfg.autoApproveWrite ? "auto" : cfg.autoApproveWrite ? "accept-edits" : "ask");
    this.timeline = new ActivityTimeline({ verbose: options.verbose });
    this.agentRules = RuleLoader.loadAgentRules(undefined, workingDirectory);
    this.messages.push({
      role: "system",
      content: buildAgentSystemPrompt(this.agentRules, {
        toolMode: this.toolMode,
        allowBrowser: this.allowBrowser,
        permissionProfile: this.permissionProfile,
      })
    });
  }

  public hasProvider(): boolean {
    return this.provider !== null;
  }

  public getProviderLabel(): string {
    if (this.provider) return `${this.provider.name}/${this.provider.model}`;
    const cfg = configManager.get();
    return `${cfg.provider}/${cfg.model}`;
  }

  public getModelName(): string {
    return this.provider?.model || configManager.get().model;
  }

  public getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  public setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
    this.reloadAgentRules();
  }

  public getAgentRules(): SecurityRule[] {
    return this.agentRules;
  }

  public getToolMode(): CliToolMode {
    return this.toolMode;
  }

  public setToolMode(mode: CliToolMode): void {
    this.toolMode = normalizeToolMode(mode);
    this.refreshSystemPrompt();
  }

  public getPermissionProfile(): PermissionProfile {
    return this.permissionProfile;
  }

  public setPermissionProfile(profile: PermissionProfile): void {
    this.permissionProfile = profile;
    this.refreshSystemPrompt();
  }

  public getAllowBrowser(): boolean {
    return this.allowBrowser;
  }

  public setAllowBrowser(allow: boolean): void {
    this.allowBrowser = Boolean(allow);
    this.refreshSystemPrompt();
  }

  public getTimeline(): ActivityTimeline {
    return this.timeline;
  }

  public toggleVerbose(): boolean {
    return this.timeline.toggleVerbose();
  }

  public isVerbose(): boolean {
    return this.timeline.isVerbose();
  }

  private refreshSystemPrompt(): void {
    const content = buildAgentSystemPrompt(this.agentRules, {
      toolMode: this.toolMode,
      allowBrowser: this.allowBrowser,
      permissionProfile: this.permissionProfile,
    });
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = content;
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  public reloadAgentRules(): SecurityRule[] {
    this.agentRules = RuleLoader.loadAgentRules(undefined, this.workingDirectory);
    this.refreshSystemPrompt();
    return this.agentRules;
  }

  public setProvider(provider: LLMProvider | null): void {
    this.provider = provider;
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public loadMessages(saved: ChatMessage[]): void {
    const rest = saved.filter((m) => m.role !== "system");
    this.messages = [
      {
        role: "system",
        content: buildAgentSystemPrompt(this.agentRules, {
          toolMode: this.toolMode,
          allowBrowser: this.allowBrowser,
          permissionProfile: this.permissionProfile,
        }),
      },
      ...rest,
    ];
  }

  public truncateHistoryTo(messageCount: number): void {
    const bounded = Math.max(1, Math.min(messageCount, this.messages.length));
    this.messages.length = bounded;
  }

  public compactNow(): { before: number; after: number } {
    const before = this.messages.length;
    const mgr = new ContextManager(0);
    this.messages = mgr.compactMessages(this.messages);
    return { before, after: this.messages.length };
  }

  public getContextBreakdown(): ContextBreakdown {
    let systemChars = 0;
    let userChars = 0;
    let assistantChars = 0;
    let toolChars = 0;
    for (const msg of this.messages) {
      const len = msg.content ? msg.content.length : 0;
      if (msg.role === "system") systemChars += len;
      else if (msg.role === "user") userChars += len;
      else if (msg.role === "assistant") assistantChars += len;
      else if (msg.role === "tool") toolChars += len;
    }
    const totalChars = systemChars + userChars + assistantChars + toolChars;
    const maxChars = 40000;
    const fillPercent = Math.min(100, Math.round((totalChars / maxChars) * 100));
    return {
      systemChars,
      userChars,
      assistantChars,
      toolChars,
      totalChars,
      maxChars,
      fillPercent,
      estimatedTokens: Math.ceil(totalChars / 4),
      messageCount: Math.max(0, this.messages.length - 1),
    };
  }

  public getLastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant" && this.messages[i].content.trim()) {
        return this.messages[i].content.trim();
      }
    }
    return "";
  }

  public getLastCodeBlock(): string {
    const text = this.getLastAssistantText();
    if (!text) return "";
    const matches = [...text.matchAll(/```(?:[a-zA-Z0-9_+-]+)?\n([\s\S]*?)```/g)];
    if (matches.length === 0) return "";
    return matches[matches.length - 1][1].trimEnd();
  }

  public getStats(): AgentStats {
    return {
      turns: this.totalTurns,
      toolCalls: this.totalToolCalls,
      messageCount: Math.max(0, this.messages.length - 1),
      ruleCount: this.agentRules.length,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
    };
  }

  public clearHistory(): void {
    this.totalTurns = 0;
    this.totalToolCalls = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.timeline.clearHistory();
    this.messages = [{
      role: "system",
      content: buildAgentSystemPrompt(this.agentRules, {
        toolMode: this.toolMode,
        allowBrowser: this.allowBrowser,
        permissionProfile: this.permissionProfile,
      })
    }];
  }

  public async runPrompt(userPrompt: string, options: RunPromptOptions = {}): Promise<string> {
    if (!this.provider) {
      this.provider = createOptionalProvider();
    }
    if (!this.provider) {
      throw new Error("No AI model provider is configured yet. Run /setup or /key <provider> <apiKey>.");
    }

    const cfg = configManager.get();
    const effectiveProfile = options.permissionProfile ?? this.permissionProfile;
    const safeCheckpoint = this.messages.length;
    this.messages.push({
      role: "user",
      content: userPrompt
    });
    this.totalTurns++;

    let tools = getToolDefinitions({
      toolMode: this.toolMode,
      allowBrowser: this.allowBrowser,
    });
    if (effectiveProfile === "plan") {
      tools = tools.filter((t) => !PLAN_BLOCKED_TOOLS.has(t.name));
    }

    const useTimeline = !options.silent;
    const timeline =
      options.statusStream && options.statusStream !== process.stdout
        ? new ActivityTimeline({ stream: options.statusStream, verbose: this.timeline.isVerbose() })
        : this.timeline;
    const callCounts = new Map<string, number>();
    let iteration = 0;
    let finalAssistantText = "";
    let incompleteToolLoop = false;

    options.onStreamEvent?.({ type: "start" });

    try {
      while (iteration < cfg.maxIterations) {
        if (options.signal?.aborted) {
          throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        }
        iteration++;
        incompleteToolLoop = false;
        this.messages = this.contextManager.compactMessages(this.messages);
        debugLog("agent", `iteration=${iteration}/${cfg.maxIterations} messages=${this.messages.length}`);

        if (useTimeline) {
          timeline.startThinking(effectiveProfile === "plan" ? "Planning..." : "Thinking...");
        }

        let streamedText = "";
        let response;
        const streamSanitizer = RuleLoader.createStreamSanitizer(this.agentRules);
        const mdRenderer =
          !options.silent && !options.rawOutput
            ? new StreamingMarkdownRenderer({ stream: process.stdout, indent: "  " })
            : null;

        try {
          response = await this.provider.chatStream(
            this.messages,
            tools,
            (chunk) => {
              const clean = streamSanitizer.push(chunk);
              if (!clean) return;
              if (!streamedText && useTimeline) {
                timeline.stopThinking();
              }
              streamedText += clean;
              options.onStreamEvent?.({ type: "chunk", text: clean });
              if (!options.silent) {
                if (mdRenderer) mdRenderer.push(clean);
                else process.stdout.write(clean);
              }
            },
            options.signal,
            (ev) => {
              if (ev.type === "usage") {
                this.totalInputTokens += ev.inputTokens || 0;
                this.totalOutputTokens += ev.outputTokens || 0;
              }
              options.onStreamEvent?.({ type: "provider_event", event: ev });
              if (useTimeline && !streamedText) {
                timeline.handleProviderEvent(ev);
              }
            }
          );
          const trailing = streamSanitizer.flush();
          if (trailing) {
            if (!streamedText && useTimeline) timeline.stopThinking();
            streamedText += trailing;
            options.onStreamEvent?.({ type: "chunk", text: trailing });
            if (!options.silent) {
              if (mdRenderer) mdRenderer.push(trailing);
              else process.stdout.write(trailing);
            }
          }
          if (response.usage) {
            this.totalInputTokens += response.usage.inputTokens || 0;
            this.totalOutputTokens += response.usage.outputTokens || 0;
          }
        } catch (err: any) {
          if (useTimeline) timeline.stopThinking();
          mdRenderer?.finish();
          if (isAbortError(err) || options.signal?.aborted) {
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          }
          options.onStreamEvent?.({ type: "error", error: err?.message || String(err) });
          throw err;
        }

        if (useTimeline) timeline.stopThinking();
        if (mdRenderer) {
          mdRenderer.finish();
        } else if (!options.silent && streamedText && !streamedText.endsWith("\n")) {
          process.stdout.write("\n");
        }

        finalAssistantText = RuleLoader.sanitizeOutput(response.content || "", this.agentRules);

        this.messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls
        });

        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }
        incompleteToolLoop = true;

        for (const tc of response.toolCalls) {
          if (options.signal?.aborted) {
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          }
          this.totalToolCalls++;
          options.onStreamEvent?.({ type: "tool_start", tool: tc.name, args: tc.arguments });

          const sig = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          const count = (callCounts.get(sig) || 0) + 1;
          callCounts.set(sig, count);

          if (count > 3) {
            const suppressed = {
              success: false,
              output: "",
              error: "Duplicate tool call suppressed (repeated call limit exceeded).",
            };
            if (useTimeline) {
              timeline.finishTool(tc.id, tc.name, tc.arguments, suppressed, 0);
            }
            options.onStreamEvent?.({ type: "tool_end", tool: tc.name, success: false, elapsedMs: 0, error: suppressed.error });
            this.messages.push({
              role: "tool",
              name: tc.name,
              toolCallId: tc.id,
              content: "ERROR: Duplicate tool call suppressed. Synthesize findings or choose another action."
            });
            continue;
          }

          if (useTimeline) {
            timeline.startTool(tc.name, tc.arguments);
          }
          const t0 = Date.now();
          let result;
          try {
            const autoWrite =
              options.autoApproveWrite !== undefined
                ? options.autoApproveWrite
                : effectiveProfile === "accept-edits" || effectiveProfile === "auto"
                  ? true
                  : effectiveProfile === "ask"
                    ? false
                    : cfg.autoApproveWrite;
            const autoRun =
              options.autoApproveRun !== undefined
                ? options.autoApproveRun
                : effectiveProfile === "auto"
                  ? true
                  : effectiveProfile === "ask" || effectiveProfile === "accept-edits"
                    ? false
                    : cfg.autoApproveRun;

            result = await executeTool(tc.name, tc.arguments, {
              workingDirectory: this.workingDirectory,
              toolMode: this.toolMode,
              permissionProfile: effectiveProfile,
              allowBrowser: this.allowBrowser,
              autoApproveRead: cfg.autoApproveRead,
              autoApproveWrite: autoWrite,
              autoApproveRun: autoRun,
              signal: options.signal,
              sessionApprovedTools: options.sessionApprovedTools,
              evaluatePermission: options.evaluatePermission,
              onFileChange: options.onFileChange,
              onOutputLine: useTimeline ? (line) => timeline.pushOutputLine(line) : undefined,
              requestApproval: options.requestApproval
                ? async (req) => {
                    if (useTimeline) timeline.pauseForPrompt();
                    return options.requestApproval!(req);
                  }
                : undefined,
            });
          } catch (toolErr: any) {
            result = { success: false, output: "", error: toolErr?.message || String(toolErr) };
          }

          const elapsed = Date.now() - t0;
          if (useTimeline) {
            timeline.finishTool(tc.id, tc.name, tc.arguments, result, elapsed);
          }
          options.onStreamEvent?.({
            type: "tool_end",
            tool: tc.name,
            success: result.success,
            elapsedMs: elapsed,
            error: result.error,
          });

          const toolOutput = result.success ? result.output : `ERROR: ${result.error}`;
          this.messages.push({
            role: "tool",
            name: tc.name,
            toolCallId: tc.id,
            content: toolOutput
          });
        }
      }
      if (incompleteToolLoop && iteration >= cfg.maxIterations) {
        const warnText = `Reached maximum tool iterations (${cfg.maxIterations}); stopping execution loop.`;
        if (useTimeline) {
          const outStream = options.statusStream ?? process.stdout;
          outStream.write(`\n  ${theme.warn(glyphs.warn)} ${theme.muted(warnText)}\n`);
        }
        finalAssistantText = finalAssistantText
          ? `${finalAssistantText}\n\n[WARN] ${warnText}`
          : `[WARN] ${warnText}`;
      }
    } catch (err: any) {
      if (useTimeline) {
        timeline.stopThinking();
        timeline.stopActiveToolBlock();
      }
      if (isAbortError(err) || options.signal?.aborted) {
        this.messages.length = safeCheckpoint;
        return "";
      }
      throw err;
    }

    options.onStreamEvent?.({ type: "done", text: finalAssistantText });
    return finalAssistantText;
  }
}
