export function isDebugEnabled(): boolean {
  return process.env.WIDE_DEBUG === "1" || process.env.WIDE_VERBOSE === "1";
}

export function enableDebugLogging(): void {
  process.env.WIDE_DEBUG = "1";
}

export function debugLog(scope: string, message: string): void {
  if (!isDebugEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[wide:debug ${ts}] [${scope}] ${message}\n`);
}
