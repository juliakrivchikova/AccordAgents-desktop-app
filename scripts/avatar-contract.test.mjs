import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const avatarComponent = read("src/renderer/components/avatar/avatar.tsx");
const chatAvatars = read("src/renderer/components/chat/chat-avatars.ts");
const settingsGeneral = read("src/renderer/components/settings/general-settings-section.tsx");
const avatarCssFiles = [
  "src/renderer/styles/views/content-markdown.css",
  "src/renderer/styles/views/chat-conversation.css",
  "src/renderer/styles/views/visual-normalization.css",
  "src/renderer/styles/views/token-overrides.css",
  "src/renderer/styles/views/chat-setup.css",
  "src/renderer/styles/views/settings-participants.css",
  "src/renderer/styles/views/settings-roles.css",
  "src/renderer/styles/views/settings-rules.css"
];
const avatarCss = avatarCssFiles.map((path) => read(path)).join("\n");

test("avatar specs carry explicit glyph/photo media modes", () => {
  assert.match(chatAvatars, /export type AvatarMediaMode = "glyph" \| "photo";/);
  assert.match(chatAvatars, /mediaMode\?: AvatarMediaMode;/);
  assert.match(chatAvatars, /"accordagents-mark"[\s\S]*mediaMode: "glyph"/);
  assert.match(chatAvatars, /id: "codex-logo"[\s\S]*mediaMode: "glyph"/);
  assert.match(chatAvatars, /id: "claude-logo"[\s\S]*mediaMode: "glyph"/);

  const options = chatAvatars.match(/const CHAT_AVATAR_OPTIONS: ChatAvatarOption\[] = \[([\s\S]*?)\n\];/)?.[1] ?? "";
  const optionRows = options.split("\n").filter((line) => line.includes("{ id:"));
  assert.ok(optionRows.length > 0, "expected avatar option rows");
  for (const row of optionRows) {
    assert.match(row, /mediaMode: "(glyph|photo)"/, row.trim());
  }
});

test("Avatar renders a single media class contract", () => {
  assert.match(avatarComponent, /spec\.mediaMode \?\? \(spec\.kind === "custom" \? "photo" : "glyph"\)/);
  assert.match(avatarComponent, /avatar-media avatar-media-\$\{mediaMode\}/);
  assert.doesNotMatch(avatarComponent, /provider-avatar-image|custom-avatar-image/);
});

test("avatar CSS has one frame rule and two media geometry rules", () => {
  assert.match(avatarCss, /\.avatar-icon\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;[\s\S]*overflow:\s*hidden;[\s\S]*box-sizing:\s*border-box;[\s\S]*\}/);
  assert.match(avatarCss, /\.avatar-icon \.avatar-media-glyph\s*\{[\s\S]*width:\s*75%;[\s\S]*height:\s*75%;[\s\S]*object-fit:\s*contain;[\s\S]*\}/);
  assert.match(avatarCss, /\.avatar-icon \.avatar-media-photo\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*object-fit:\s*cover;[\s\S]*\}/);
});

test("old per-kind avatar geometry hooks are removed", () => {
  const banned = [
    /provider-avatar-image/,
    /custom-avatar-image/,
    /\.avatar-icon svg\s*\{/,
    /\.avatar-icon img\s*\{/,
    /\.avatar-anthropic svg/,
    /\.mini-avatar img/,
    /\.participants-card-avatar\.avatar-codex/,
    /\.chat-thread-avatar\.avatar-custom/,
    /avatar-choice-claude-logo/,
    /transform:\s*scale\(1\.2\)/
  ];
  for (const pattern of banned) {
    assert.doesNotMatch(avatarCss, pattern, pattern.toString());
  }

  for (const match of avatarCss.matchAll(/([^{}]*\.avatar-(?:codex|custom)[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(match[2], /padding\s*:/, match[1].trim());
    assert.doesNotMatch(match[2], /object-fit\s*:/, match[1].trim());
    assert.doesNotMatch(match[2], /transform\s*:/, match[1].trim());
  }

  for (const match of avatarCss.matchAll(/(^|\n)(\.avatar-(?:codex|custom))\s*\{([^{}]*)\}/g)) {
    assert.doesNotMatch(match[3], /border\s*:/, match[2]);
    assert.doesNotMatch(match[3], /box-shadow\s*:/, match[2]);
  }

  for (const match of avatarCss.matchAll(/([^{}]*(?:avatar-choice-preview|participants-card-avatar|participants-mini-avatar|roles-mini-avatar|rules-mini-avatar|chat-app-tool-(?:approval|review|roster)-avatar|chat-app-tool-avatar-choice-img)[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(match[2], /overflow\s*:\s*visible/, match[1].trim());
  }

  for (const match of avatarCss.matchAll(/([^{}]*avatar-choice-preview[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(match[2], /border-radius\s*:\s*0\b/, match[1].trim());
  }
});

test("Claude logo imports use the transparent PNG asset", () => {
  assert.match(avatarComponent, /claude-avatar\.png/);
  assert.match(chatAvatars, /claude-avatar\.png/);
  assert.match(settingsGeneral, /claude-avatar\.png/);
  assert.doesNotMatch(`${avatarComponent}\n${chatAvatars}\n${settingsGeneral}`, /claude-avatar\.webp/);
});

test("Claude logo asset is transparent RGBA with visible glyph pixels", () => {
  const png = readFileSync(new URL("../src/renderer/assets/claude-avatar.png", import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = -1;
  let colorType = -1;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    offset += 4;
    const type = png.toString("ascii", offset, offset + 4);
    offset += 4;
    const data = png.subarray(offset, offset + length);
    offset += length + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
  }

  assert.equal(width, 1280);
  assert.equal(height, 1280);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6);

  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = decodePngRgba(inflated, width, height);
  let minAlpha = 255;
  let maxAlpha = 0;
  const alphaBounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const alpha = rgba[row * width * 4 + column * 4 + 3];
      minAlpha = Math.min(minAlpha, alpha);
      maxAlpha = Math.max(maxAlpha, alpha);
      if (alpha > 8) {
        alphaBounds.minX = Math.min(alphaBounds.minX, column);
        alphaBounds.minY = Math.min(alphaBounds.minY, row);
        alphaBounds.maxX = Math.max(alphaBounds.maxX, column);
        alphaBounds.maxY = Math.max(alphaBounds.maxY, row);
      }
    }
  }
  assert.equal(minAlpha, 0);
  assert.equal(maxAlpha, 255);
  alphaBounds.widthRatio = (alphaBounds.maxX - alphaBounds.minX + 1) / width;
  alphaBounds.heightRatio = (alphaBounds.maxY - alphaBounds.minY + 1) / height;
  assert.ok(alphaBounds.widthRatio > 0.99);
  assert.ok(alphaBounds.heightRatio > 0.99);
});

function decodePngRgba(inflated, width, height) {
  const stride = width * 4;
  const bytesPerPixel = 4;
  const out = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const inOffset = row * (stride + 1);
    const outOffset = row * stride;
    const filter = inflated[inOffset];
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inOffset + 1 + x];
      const left = x >= bytesPerPixel ? out[outOffset + x - bytesPerPixel] : 0;
      const up = row > 0 ? out[outOffset - stride + x] : 0;
      const upLeft = row > 0 && x >= bytesPerPixel ? out[outOffset - stride + x - bytesPerPixel] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      out[outOffset + x] = value & 255;
    }
  }
  return out;
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}
