<p align="center">
  <img src="assets/wide-logo.png" alt="Wide CLI" width="128">
  <h1 align="center">Wide CLI</h1>
  <p align="center">Terminal-first autonomous AI coding & security agent for the Wide ecosystem</p>
</p>

<p align="center">
  <a href="https://github.com/sl4de0day/wide-cli/releases/latest">Download</a> ·
  <a href="#building-from-source">Build</a> ·
  <a href="https://github.com/sl4de0day/wide-cli/releases">Changelog</a> ·
  <a href="https://github.com/sl4de0day/wide-ide">Wide IDE</a> ·
  <a href="https://github.com/sl4de0day/wide-app">Wide App</a> ·
  <a href="https://github.com/sl4de0day/wide-sdk">Wide SDK</a> ·
  <a href="https://github.com/sl4de0day/wide-action">Wide Action</a> ·
  <a href="https://github.com/sl4de0day/wide-rules">Wide Rules</a> ·
  <a href="LICENSE">License</a>
</p>

---

## Overview

Wide CLI brings the power of Wide's autonomous AI coding, database management, and web security agents directly to your terminal. Edit code, debug applications, inspect databases, and run security audits without leaving your terminal flow.

- **Autonomous AI Coding:** Read files, edit code with ANSI colored diff confirmations, run shell commands, and navigate complex codebases with lazy startup under 50 ms.
- **Integrated Database 2.0:** Multi-engine database inspection and querying for SQLite, PostgreSQL, MySQL, and Redis with execution duration, persistent query history, CSV/JSON/SQL data export, and Mermaid ERD generation via `/db` and agent tools.
- **Real CDP Browser Automation:** Full Chromium/Edge automation across 16 tools with element ref (`@eN`) interaction, screenshot capture, HAR 1.2 traffic export with header redaction, and stealth evasion mode.
- **Native SAST & Security Engine:** Instant vulnerability detection (SQLi, XSS, SSRF, command injection, secret leakage) backed by SHA256SUMS-verified dynamic rules, offline OSV bundles, and non-destructive AST suppression.
- **Terminal Ergonomics & Shell Completion:** Interactive persistent REPL with history persistence, session save/resume (`--resume`, `--continue`), shell completion (`wide completion install` for PowerShell, Bash, and Zsh), slash commands, and top-level `wide update` command.
- **Model Agnostic:** Works seamlessly with local models via **Ollama** (offline, private, 0 telemetry) or cloud APIs (**Gemini**, **Claude**, **DeepSeek**, **OpenAI**).

## Installation

```bash
npm install -g wide-cli
wide
```

## Building from Source

```bash
git clone https://github.com/sl4de0day/wide-cli.git
cd wide-cli
npm install
npm run build
npm test
npm link
```

## Quick Start

### 1. Interactive Mode (REPL)
Launch Wide CLI in any project directory:
```bash
wide
```

### 2. One-Shot Prompt
Ask Wide to perform a specific task directly:
```bash
wide "Find and fix any SQL injection risks in the api/ directory"
```

### 3. Piping Input
Pipe diffs or command logs into Wide for review:
```bash
git diff | wide "Review this diff for security flaws and performance bottlenecks"
```

## Configuration

Configure your default model and API keys:
```bash
wide config set provider gemini
wide config set-key gemini YOUR_GEMINI_API_KEY

wide config set provider ollama
wide config set model deepseek
```

## License
GPL-3.0-or-later sl4de
