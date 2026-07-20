#!/usr/bin/env node
// make-icons.mjs — 生成 Web/PWA 和 iOS 图标（暖色底 + 12 向 starburst），零依赖。
// 用法：node web/mock/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_OUT = path.join(ROOT, 'web/icons');
const IOS_PUBLIC_OUT = path.join(ROOT, 'ios/App/App/public/icons');
const IOS_APP_ICON = path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
for (const outputDirectory of [WEB_OUT, IOS_PUBLIC_OUT, path.dirname(IOS_APP_ICON)]) {
  mkdirSync(outputDirectory, { recursive: true });
}

// ---- 最小 PNG 编码器（RGB8、filter 0）
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(size, pixels /* RGB Uint8Array */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.subarray(y * size * 3, (y + 1) * size * 3).forEach((value, index) => {
      raw[y * (size * 3 + 1) + 1 + index] = value;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 绘制：暖深底 + 珊瑚色 12 向 starburst
const BG = [0x26, 0x26, 0x24];
const FG = [0xd9, 0x77, 0x57];
const RAYS = [
  { angle: -90, length: 0.36, width: 0.052 },
  { angle: -60, length: 0.35, width: 0.056 },
  { angle: -30, length: 0.32, width: 0.050 },
  { angle: 0, length: 0.36, width: 0.052 },
  { angle: 30, length: 0.33, width: 0.056 },
  { angle: 60, length: 0.31, width: 0.050 },
  { angle: 90, length: 0.35, width: 0.052 },
  { angle: 120, length: 0.32, width: 0.055 },
  { angle: 150, length: 0.34, width: 0.054 },
  { angle: 180, length: 0.36, width: 0.048 },
  { angle: 210, length: 0.33, width: 0.056 },
  { angle: 240, length: 0.36, width: 0.058 },
];

function distanceToSegment(x, y, endX, endY) {
  const lengthSquared = endX * endX + endY * endY;
  const projection = Math.min(1, Math.max(0, (x * endX + y * endY) / lengthSquared));
  return Math.hypot(x - projection * endX, y - projection * endY);
}

function draw(size) {
  const pixels = new Uint8Array(size * size * 3);
  const center = size / 2;
  const antialias = Math.max(1, size / 512);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offsetX = x + 0.5 - center;
      const offsetY = y + 0.5 - center;
      let coverage = 0;
      for (const ray of RAYS) {
        const radians = ray.angle * Math.PI / 180;
        const rayLength = ray.length * size;
        const distance = distanceToSegment(
          offsetX,
          offsetY,
          Math.cos(radians) * rayLength,
          Math.sin(radians) * rayLength,
        );
        const rayCoverage = Math.min(1, Math.max(0, (ray.width * size / 2 - distance) / antialias + 0.5));
        coverage = Math.max(coverage, rayCoverage);
      }
      const index = (y * size + x) * 3;
      pixels[index] = BG[0] + (FG[0] - BG[0]) * coverage;
      pixels[index + 1] = BG[1] + (FG[1] - BG[1]) * coverage;
      pixels[index + 2] = BG[2] + (FG[2] - BG[2]) * coverage;
    }
  }
  return pixels;
}

for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  const png = encodePng(size, draw(size));
  writeFileSync(path.join(WEB_OUT, name), png);
  writeFileSync(path.join(IOS_PUBLIC_OUT, name), png);
  console.log(`✓ ${name} (${size}x${size}, Web + iOS public)`);
}

// ---- SVG（favicon / manifest 可缩放图标）
const svgRays = RAYS.map((ray) => {
  const radians = ray.angle * Math.PI / 180;
  const endX = 64 + Math.cos(radians) * ray.length * 128;
  const endY = 64 + Math.sin(radians) * ray.length * 128;
  return `<line x1="64" y1="64" x2="${endX.toFixed(1)}" y2="${endY.toFixed(1)}" stroke-width="${(ray.width * 128).toFixed(1)}"/>`;
}).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#262624"/><g stroke="#d97757" stroke-linecap="round">${svgRays}</g></svg>\n`;
writeFileSync(path.join(WEB_OUT, 'icon.svg'), svg);
writeFileSync(path.join(IOS_PUBLIC_OUT, 'icon.svg'), svg);
console.log('✓ icon.svg (Web + iOS public)');

writeFileSync(IOS_APP_ICON, encodePng(1024, draw(1024)));
console.log('✓ AppIcon-512@2x.png (1024x1024, RGB/no alpha)');
