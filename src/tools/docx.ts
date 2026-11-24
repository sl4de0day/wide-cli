import { inflateRawSync } from "node:zlib";

export type DocxExtractResult =
  | { ok: true; text: string; paragraphs: number }
  | { ok: false; error: string };

const DOCX_MAX_XML_BYTES = 16 * 1024 * 1024;

export function isDocxPath(filePath: string): boolean {
  return String(filePath || "").trim().toLowerCase().endsWith(".docx");
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const c = Number.parseInt(dec, 10);
      return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const c = Number.parseInt(hex, 16);
      return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "";
    })
    .replace(/&amp;/g, "&");
}

function extractEntryFromCentralDirectory(buf: Buffer, targetName: string): { method: number; data: Buffer } | null {
  const minScan = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minScan; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0 || eocdOffset + 20 > buf.length) return null;

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  if (cdOffset === 0xffffffff || cdOffset + cdSize > buf.length) return null;

  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (cursor + 46 <= cdEnd) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLen > buf.length) break;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    if (name === targetName) {
      if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        return null;
      }
      const lfNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lfExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
      if (dataStart + compSize > buf.length) return null;
      return { method: compMethod, data: buf.subarray(dataStart, dataStart + compSize) };
    }
    cursor = nameStart + nameLen + extraLen + commentLen;
  }
  return null;
}

function extractEntryFromLocalHeaders(buf: Buffer, targetName: string): { method: number; data: Buffer } | null {
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const compMethod = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > buf.length || dataStart + compSize > buf.length) break;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    if (name === targetName) {
      return { method: compMethod, data: buf.subarray(dataStart, dataStart + compSize) };
    }
    offset = dataStart + Math.max(1, compSize);
  }
  return null;
}

function extractParagraphsFromDocumentXml(xml: string): { text: string; paragraphs: number } {
  const tokenRe = /<\/w:p>|<\/w:tr>|<\/w:tc>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:tab\b[^>]*\/?>|<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
  const paragraphs: string[] = [];
  let current = "";
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(xml)) !== null) {
    const full = m[0];
    if (m[1] !== undefined) {
      current += decodeXmlEntities(m[1]);
    } else if (full === "</w:p>" || full === "</w:tr>") {
      const trimmed = current.trimEnd();
      if (trimmed.length > 0) paragraphs.push(trimmed);
      current = "";
    } else if (full === "</w:tc>" || full.startsWith("<w:tab")) {
      if (current.length > 0 && !current.endsWith("\t")) current += "\t";
    } else if (full.startsWith("<w:br") || full.startsWith("<w:cr")) {
      current += "\n";
    }
  }
  const leftover = current.trimEnd();
  if (leftover.length > 0) paragraphs.push(leftover);

  return { text: paragraphs.join("\n"), paragraphs: paragraphs.length };
}

export function extractDocxText(buf: Buffer): DocxExtractResult {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, error: "Buffer is too small to be a .docx archive." };
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return { ok: false, error: "File does not have a valid ZIP/.docx signature." }; // wide-ignore wide/secret-in-response
  }

  const entry =
    extractEntryFromCentralDirectory(buf, "word/document.xml") ||
    extractEntryFromLocalHeaders(buf, "word/document.xml");

  if (!entry) {
    return { ok: false, error: "Missing word/document.xml inside .docx archive." };
  }

  let xmlBuf: Buffer;
  try {
    if (entry.method === 0) {
      xmlBuf = entry.data;
    } else if (entry.method === 8) {
      xmlBuf = inflateRawSync(entry.data, { maxOutputLength: DOCX_MAX_XML_BYTES });
    } else {
      return { ok: false, error: `Unsupported ZIP compression method (${entry.method}) in .docx.` };
    }
  } catch (err: any) {
    return { ok: false, error: `Failed to decompress .docx document.xml: ${err?.message || err}` };
  }

  const parsed = extractParagraphsFromDocumentXml(xmlBuf.toString("utf8"));
  return { ok: true, text: parsed.text, paragraphs: parsed.paragraphs };
}
