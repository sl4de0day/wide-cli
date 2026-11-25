import { spawnSync } from "node:child_process";

export function copyToClipboard(text: string): { ok: boolean; error?: string } {
  if (!text) return { ok: false, error: "Nothing to copy." };

  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === "win32"
      ? [
          { cmd: "powershell.exe", args: ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"] },
          { cmd: "clip.exe", args: [] },
        ]
      : process.platform === "darwin"
        ? [{ cmd: "pbcopy", args: [] }]
        : [
            { cmd: "wl-copy", args: [] },
            { cmd: "xclip", args: ["-selection", "clipboard"] },
            { cmd: "xsel", args: ["--clipboard", "--input"] },
          ];

  for (const c of candidates) {
    try {
      const res = spawnSync(c.cmd, c.args, {
        input: text,
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
      });
      if (!res.error && res.status === 0) {
        return { ok: true };
      }
    } catch {}
  }

  return { ok: false, error: "No clipboard utility available on this system." };
}
