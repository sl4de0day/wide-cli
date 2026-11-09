import pc from "picocolors";

export const colors = {
  primary: pc.cyan,
  primaryBold: (t: string) => pc.bold(pc.cyan(t)),
  accent: pc.magenta,
  accentBold: (t: string) => pc.bold(pc.magenta(t)),
  success: pc.green,
  successBold: (t: string) => pc.bold(pc.green(t)),
  warning: pc.yellow,
  warningBold: (t: string) => pc.bold(pc.yellow(t)),
  error: pc.red,
  errorBold: (t: string) => pc.bold(pc.red(t)),
  muted: pc.gray,
  bold: pc.bold,
  dim: pc.dim,
  inverse: pc.inverse,
  underline: pc.underline,
};
