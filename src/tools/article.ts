export interface ExtractedArticle {
  title: string;
  cleanText: string;
  author: string;
  date: string;
  description: string;
  publisher: string;
  image: string;
  allImages: string[];
  keywords: string[];
  textLength: number;
  url: string;
}

export const FAST_READ_BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
]);

export const FAST_READ_TRACKER_PATTERNS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "facebook.net/en_us/fbevents",
  "connect.facebook.net",
  "analytics.tiktok.com",
  "hotjar.com",
  "segment.io",
  "mixpanel.com",
  "scorecardresearch.com",
];

export function shouldBlockFastReadRequest(resourceType: string, reqUrl: string): boolean {
  const rType = String(resourceType || "").toLowerCase();
  if (FAST_READ_BLOCKED_RESOURCE_TYPES.has(rType)) {
    return true;
  }
  const lowerUrl = String(reqUrl || "").toLowerCase();
  return FAST_READ_TRACKER_PATTERNS.some((pat) => lowerUrl.includes(pat));
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function parseTagAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const k = m[1].toLowerCase();
    const v = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[k] = decodeHtmlEntities(v).trim();
  }
  return attrs;
}

function resolveMaybeUrl(raw: string, baseUrl: string): string {
  const val = String(raw || "").trim();
  if (!val) return "";
  try {
    return baseUrl ? new URL(val, baseUrl).href : val;
  } catch {
    return val;
  }
}

function stripNonContentBlocks(html: string, aggressive: boolean): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form)\b[\s\S]*?<\/\1>/gi, " ");
  if (aggressive) {
    s = s
      .replace(/<(nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(?:div|section|ul)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:nav|menu|sidebar|footer|header|cookie|banner|breadcrumb|related|comment|social|share|advert|promo|popup|modal)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|ul)>/gi, " ");
  }
  return s;
}

function htmlSliceToParagraphs(fragment: string): string[] {
  const withBreaks = fragment
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|pre|figcaption|tr|section|article)>/gi, "\n\n")
    .replace(/<(?:li)\b[^>]*>/gi, "- ");
  const stripped = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "));
  const blocks = stripped
    .split(/\n{2,}/)
    .map((line) => line.replace(/[ \t\r\n]+/g, " ").trim())
    .filter((line) => line.length >= 2);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
  }
  return out;
}

export function extractArticleFromHtml(html: string, url = ""): ExtractedArticle {
  const src = String(html || "");
  const metaMap = new Map<string, string>();
  const metaRe = /<meta\b([^>]*)>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(src)) !== null) {
    const attrs = parseTagAttrs(mm[1]);
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !metaMap.has(key)) {
      metaMap.set(key, attrs.content);
    }
  }

  const titleTagMatch = src.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = src.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Match ? decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
  const title =
    metaMap.get("og:title") ||
    metaMap.get("twitter:title") ||
    (titleTagMatch ? decodeHtmlEntities(titleTagMatch[1]).replace(/\s+/g, " ").trim() : "") ||
    h1Text ||
    "Untitled";

  const timeTagMatch = src.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*>/i);
  const author =
    metaMap.get("author") ||
    metaMap.get("article:author") ||
    metaMap.get("parsely-author") ||
    "";
  const date =
    metaMap.get("article:published_time") ||
    metaMap.get("pubdate") ||
    metaMap.get("publish_date") ||
    metaMap.get("date") ||
    (timeTagMatch ? timeTagMatch[1].trim() : "") ||
    "";
  const description = metaMap.get("description") || metaMap.get("og:description") || metaMap.get("twitter:description") || "";
  const publisher =
    metaMap.get("og:site_name") ||
    (() => {
      try {
        return url ? new URL(url).hostname : "";
      } catch {
        return "";
      }
    })();

  const ogImage = resolveMaybeUrl(metaMap.get("og:image") || metaMap.get("twitter:image") || "", url);
  const kwRaw = metaMap.get("keywords") || metaMap.get("news_keywords") || "";
  const keywords = kwRaw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const sanitizedBase = stripNonContentBlocks(src, false);
  const articleMatch = sanitizedBase.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch =
    sanitizedBase.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ||
    sanitizedBase.match(/<div\b[^>]*role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div>/i);

  let primaryScope = "";
  if (articleMatch && articleMatch[1].length >= 120) {
    primaryScope = articleMatch[1];
  } else if (mainMatch && mainMatch[1].length >= 120) {
    primaryScope = mainMatch[1];
  }

  let paragraphs = primaryScope ? htmlSliceToParagraphs(stripNonContentBlocks(primaryScope, true)) : [];
  if (paragraphs.join("\n\n").length < 80) {
    paragraphs = htmlSliceToParagraphs(stripNonContentBlocks(src, true));
  }
  if (paragraphs.length === 0) {
    paragraphs = htmlSliceToParagraphs(sanitizedBase);
  }

  const allImages: string[] = [];
  const imgScope = primaryScope || sanitizedBase;
  const imgRe = /<img\b([^>]*)>/gi;
  let im: RegExpExecArray | null;
  const imgSeen = new Set<string>();
  while ((im = imgRe.exec(imgScope)) !== null) {
    const attrs = parseTagAttrs(im[1]);
    const resolved = resolveMaybeUrl(attrs.src || attrs["data-src"] || "", url);
    if (resolved && !resolved.startsWith("data:") && !imgSeen.has(resolved)) {
      imgSeen.add(resolved);
      allImages.push(resolved);
      if (allImages.length >= 40) break;
    }
  }

  const cleanText = paragraphs.join("\n\n");
  return {
    title,
    cleanText,
    author,
    date,
    description,
    publisher,
    image: ogImage || allImages[0] || "",
    allImages,
    keywords,
    textLength: cleanText.length,
    url,
  };
}
