import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAllPayloadTypes } from "./security/payloads.js";

export type SupportedShell = "powershell" | "bash" | "zsh";

export function normalizeShellName(input?: string): SupportedShell {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) {
    if (process.platform === "win32") return "powershell";
    if ((process.env.SHELL || "").toLowerCase().includes("zsh")) return "zsh";
    return "bash";
  }
  if (raw === "powershell" || raw === "pwsh" || raw === "ps" || raw === "ps1") {
    return "powershell";
  }
  if (raw === "bash" || raw === "sh") {
    return "bash";
  }
  if (raw === "zsh") {
    return "zsh";
  }
  throw new Error(`Unsupported shell '${input}'. Choose powershell, bash, or zsh.`);
}

export function generateCompletionScript(shellInput?: string): string {
  const shell = normalizeShellName(shellInput);
  const payloads = getAllPayloadTypes();

  if (shell === "powershell") {
    const payloadArray = payloads.map((p) => `'${p}'`).join(", ");
    return [
      `$null = 'wide-cli-completion-start'`,
      `Register-ArgumentCompleter -Native -CommandName wide -ScriptBlock {`,
      `  param($wordToComplete, $commandAst, $cursorPosition)`,
      `  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })`,
      `  $sub = if ($tokens.Count -gt 1) { $tokens[1] } else { '' }`,
      `  $prev = if ($tokens.Count -gt 1) { $tokens[$tokens.Count - 1] } else { '' }`,
      `  if ($prev -eq '--shell') {`,
      `    $items = @('powershell', 'bash', 'zsh')`,
      `  } elseif ($prev -eq '--provider') {`,
      `    $items = @('gemini', 'ollama', 'claude', 'deepseek', 'openai')`,
      `  } elseif ($prev -eq '--severity' -or $prev -eq '-s') {`,
      `    $items = @('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'ALL')`,
      `  } elseif ($sub -eq 'rules') {`,
      `    $items = @('update', 'path', 'agent')`,
      `  } elseif ($sub -eq 'config') {`,
      `    $items = @('list', 'set', 'set-key')`,
      `  } elseif ($sub -eq 'completion') {`,
      `    $items = @('install', '--shell', '--profile')`,
      `  } elseif ($sub -eq 'payloads') {`,
      `    $items = @(${payloadArray})`,
      `  } elseif ($sub -eq 'scan') {`,
      `    $items = @('--severity', '--rules')`,
      `  } elseif ($sub -eq 'fuzz') {`,
      `    $items = @('--method')`,
      `  } else {`,
      `    $items = @('scan', 'update', 'upgrade', 'rules', 'payloads', 'fuzz', 'config', 'completion', '--print', '--continue', '--resume', '--provider', '--model', '--yes', '--help', '--version')`,
      `  }`,
      `  $items | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {`,
      `    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)`,
      `  }`,
      `}`,
      `$null = 'wide-cli-completion-end'`,
    ].join("\n");
  }

  if (shell === "zsh") {
    const payloadWords = payloads.join(" ");
    return [
      `: "wide-cli-completion-start"`,
      `function _wide {`,
      `  local -a commands sub_rules sub_config sub_completion payload_types providers severities`,
      `  commands=('scan:Run native SAST security scan' 'update:Update CLI and rules' 'upgrade:Update CLI and rules' 'rules:Manage security rules' 'payloads:Output security payloads' 'fuzz:Probe endpoint parameter' 'config:Manage configuration' 'completion:Generate shell completion')`,
      `  sub_rules=('update:Synchronize rules' 'path:Print cache path' 'agent:List active AI agent rules')`,
      `  sub_config=('list:List current config' 'set:Set config property' 'set-key:Store provider API key')`,
      `  sub_completion=('install:Install completion into shell profile')`,
      `  payload_types=(${payloadWords})`,
      `  providers=(gemini ollama claude deepseek openai)`,
      `  severities=(CRITICAL HIGH MEDIUM LOW ALL)`,
      `  if (( CURRENT == 2 )); then`,
      `    _describe 'command' commands`,
      `    return`,
      `  fi`,
      `  case "$words[2]" in`,
      `    rules) _describe 'subcommand' sub_rules ;;`,
      `    config) _describe 'subcommand' sub_config ;;`,
      `    completion) _describe 'subcommand' sub_completion ;;`,
      `    payloads) compadd -- $payload_types ;;`,
      `    scan) _values 'severity' $severities ;;`,
      `    *) compadd -- $providers ;;`,
      `  esac`,
      `}`,
      `if (( $+functions[compdef] )); then compdef _wide wide; fi`,
      `: "wide-cli-completion-end"`,
    ].join("\n");
  }

  const payloadList = payloads.join(" ");
  return [
    `: "wide-cli-completion-start"`,
    `_wide_complete() {`,
    `  local cur prev cmd`,
    `  COMPREPLY=()`,
    `  cur="\${COMP_WORDS[COMP_CWORD]}"`,
    `  prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
    `  cmd="\${COMP_WORDS[1]}"`,
    `  if [ "$prev" = "--shell" ]; then`,
    `    COMPREPLY=( $(compgen -W "powershell bash zsh" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--provider" ]; then`,
    `    COMPREPLY=( $(compgen -W "gemini ollama claude deepseek openai" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--severity" ] || [ "$prev" = "-s" ]; then`,
    `    COMPREPLY=( $(compgen -W "CRITICAL HIGH MEDIUM LOW ALL" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$COMP_CWORD" -eq 1 ]; then`,
    `    COMPREPLY=( $(compgen -W "scan update upgrade rules payloads fuzz config completion --print --continue --resume --provider --model --yes --help --version" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  case "$cmd" in`,
    `    rules) COMPREPLY=( $(compgen -W "update path agent" -- "$cur") ) ;;`,
    `    config) COMPREPLY=( $(compgen -W "list set set-key" -- "$cur") ) ;;`,
    `    completion) COMPREPLY=( $(compgen -W "install --shell --profile" -- "$cur") ) ;;`,
    `    payloads) COMPREPLY=( $(compgen -W "${payloadList}" -- "$cur") ) ;;`,
    `    scan) COMPREPLY=( $(compgen -W "--severity --rules" -- "$cur") ) ;;`,
    `    fuzz) COMPREPLY=( $(compgen -W "--method" -- "$cur") ) ;;`,
    `  esac`,
    `}`,
    `complete -F _wide_complete wide`,
    `: "wide-cli-completion-end"`,
  ].join("\n");
}

export function defaultProfilePath(shell: SupportedShell): string {
  const home = os.homedir();
  if (shell === "powershell") {
    return path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  }
  if (shell === "zsh") {
    return path.join(home, ".zshrc");
  }
  return path.join(home, ".bashrc");
}

export function installShellCompletion(opts?: {
  shell?: string;
  profilePath?: string;
}): { shell: SupportedShell; profilePath: string; updated: boolean } {
  const shell = normalizeShellName(opts?.shell);
  const profilePath = opts?.profilePath ? path.resolve(opts.profilePath) : defaultProfilePath(shell);
  const script = generateCompletionScript(shell);

  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const startMarker = shell === "powershell" ? "$null = 'wide-cli-completion-start'" : ': "wide-cli-completion-start"';
  const endMarker = shell === "powershell" ? "$null = 'wide-cli-completion-end'" : ': "wide-cli-completion-end"';
  const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "";

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  let nextContent = existing;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).replace(/\s+$/, "");
    const after = existing.slice(endIdx + endMarker.length).replace(/^\s+/, "");
    nextContent = [before, script, after].filter(Boolean).join("\n\n") + "\n";
  } else {
    const trimmed = existing.replace(/\s+$/, "");
    nextContent = trimmed ? `${trimmed}\n\n${script}\n` : `${script}\n`;
  }

  const updated = nextContent !== existing;
  fs.writeFileSync(profilePath, nextContent, "utf8");
  return { shell, profilePath, updated };
}
