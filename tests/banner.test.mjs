import assert from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decodePngRgba, formatBannerLines, renderLogoLines } from "../dist/ui/banner.js";
import { readFileSync } from "node:fs";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function testPngBanner() {
  console.log("Testing Wide CLI PNG Logo Banner...");

  const logoPath = join(process.cwd(), "assets", "logo.png");
  assert.ok(existsSync(logoPath), "Expected assets/logo.png to exist");

  const decoded = decodePngRgba(readFileSync(logoPath));
  assert.ok(decoded && decoded.width === 2000 && decoded.height === 2000, "Expected 2000x2000 RGBA logo");

  const lines = renderLogoLines({ logoPath, colorMode: "truecolor" });
  assert.strictEqual(lines.length, 6, "Expected 6 terminal lines for 12x12 truecolor square grid");

  const joined = lines.join("\n");
  assert.ok(joined.includes("\x1b[38;2;94;129;172m"), "Expected Nord blue #5E81AC truecolor escape");
  assert.ok(joined.includes("\x1b[38;2;255;255;255m"), "Expected crisp white #FFFFFF truecolor escape");

  const plainRows = lines.map(stripAnsi);
  assert.strictEqual(plainRows[0], "    ████    ");
  assert.strictEqual(plainRows[1], "    ████    ");
  assert.strictEqual(plainRows[2], "████████████");
  assert.strictEqual(plainRows[3], "████████████");
  assert.strictEqual(plainRows[4], "████████    ");
  assert.strictEqual(plainRows[5], "████████    ");

  const monoRows = renderLogoLines({ logoPath, colorMode: "none" });
  assert.strictEqual(monoRows[0], "    ████    ");
  assert.strictEqual(monoRows[2], "▓▓▓▓████████");
  assert.strictEqual(monoRows[4], "▓▓▓▓▓▓▓▓    ");

  const bannerText = formatBannerLines("0.6.191126", { colorMode: "truecolor" }).map(stripAnsi).join("\n");
  assert.ok(!bannerText.toUpperCase().includes("WIDE CLI"), "Banner must not print WIDE CLI text");
  assert.ok(!bannerText.includes("██╗"), "Banner must not use ASCII block font letters");
  assert.ok(bannerText.includes("Wide v0.6.191126"), "Banner should show Wide version");

  console.log("[PASS] Wide PNG logo renders accurately in truecolor and monochrome");
}

testPngBanner();
