import { theme } from "./theme.js";

export { theme, NORD, glyphs, detectColorDepth, paint, setColorDepthOverride } from "./theme.js";

export const colors = {
  primary: (t: string) => theme.accent(t),
  primaryBold: (t: string) => theme.accentBold(t),
  accent: (t: string) => theme.info(t),
  accentBold: (t: string) => theme.infoBold(t),
  success: (t: string) => theme.ok(t),
  successBold: (t: string) => theme.okBold(t),
  warning: (t: string) => theme.warn(t),
  warningBold: (t: string) => theme.warnBold(t),
  error: (t: string) => theme.error(t),
  errorBold: (t: string) => theme.errorBold(t),
  muted: (t: string) => theme.muted(t),
  bold: (t: string) => theme.bold(t),
  dim: (t: string) => theme.faint(t),
  inverse: (t: string) => theme.inverse(t),
  underline: (t: string) => theme.underline(t),
};
