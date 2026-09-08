import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * The home-screen and browser-tab icons, generated rather than committed — the same
 * bargain probe.wav and the kuromoji dictionary next door strike, for the same
 * reason: a repo full of binaries nobody can review is what generating them avoids.
 * Written into Vite's `public/` by `npm run assets`, which `prebuild` and `predev:web`
 * run for you.
 *
 * Zero dependencies: `node:zlib` deflates and the PNG around it is chunk framing and
 * a CRC table, in the spirit of make-probe.ts writing a WAV header by hand. It is all
 * raster because iOS will not take an SVG for `apple-touch-icon`, and having gone
 * raster for that one there is no reason for the others to be anything else.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "src", "web", "public");

/**
 * One committed pair, taken from the light half of the palette at the top of
 * styles.css: `--accent` for the field, `--bg` for the mark. A raster file cannot
 * participate in `light-dark()`, so the same two colours have to hold up on both
 * kinds of home screen — and this pair does. The saturated blue tile separates from a
 * white background; on a black one the near-white mark carries the contrast instead.
 */
const FIELD = { r: 0x2c, g: 0x5a, b: 0xd4 }; // styles.css --accent, light half
const MARK = { r: 0xf4, g: 0xf5, b: 0xf8 }; // styles.css --bg, light half

/**
 * The mark: three vertically centred capsules of unequal height, which is the shape
 * everything that plays sound wears. Widths and gaps are fractions of the mark box
 * and add up to exactly 1, so the box is the artwork's bounding box and nothing else
 * has to know how the bars are spaced.
 *
 * The heights are stepped rather than symmetric so the silhouette still reads as a
 * wave at 16px in a browser tab, where the gaps are barely over a pixel and half the
 * detail is gone.
 */
const BAR_HEIGHTS = [0.5, 1, 0.7];
const BAR_WIDTH = 0.24;
const BAR_GAP = 0.14; // 3 × 0.24 + 2 × 0.14 = 1

/**
 * Render at 4× and box-downsample. Nothing here draws an antialiased edge, so without
 * this every curve is a staircase — which is exactly what a cheap icon looks like on
 * a home screen. Sixteen samples a pixel is seventeen levels of coverage, enough for
 * a corner radius and a capsule cap.
 */
const SS = 4;

/** Sample classes: 0 nothing, 1 field, 2 mark. One byte a sample rather than four. */
const IS_FIELD = 1;
const IS_MARK = 2;

/**
 * Every shape here is a rounded rectangle — the tile is one with a big radius, a bar
 * is one with a radius of half its width. Inside means: clamp the point into the
 * rectangle the corner centres span, then be within r of where it landed.
 */
function fillRoundRect(
  samples: Uint8Array,
  side: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  value: number,
): void {
  const from = Math.max(0, Math.floor(y0));
  const to = Math.min(side, Math.ceil(y1));
  for (let y = from; y < to; y++) {
    const py = y + 0.5;
    const cy = Math.min(Math.max(py, y0 + r), y1 - r);
    const dy = py - cy;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(side, Math.ceil(x1)); x++) {
      const px = x + 0.5;
      const cx = Math.min(Math.max(px, x0 + r), x1 - r);
      const dx = px - cx;
      if (dx * dx + dy * dy <= r * r) samples[y * side + x] = value;
    }
  }
}

/**
 * `radius` is a fraction of the icon's width; 0 means full bleed, which is what both
 * the maskable icon and iOS want — the platform applies its own circle, squircle or
 * superellipse, and an icon that rounded its own corners first would show the tile's
 * background in the gap. `mark` is the fraction of the width the artwork occupies.
 */
function icon(size: number, radius: number, mark: number): Buffer {
  const side = size * SS;
  const samples = new Uint8Array(side * side);
  fillRoundRect(samples, side, 0, 0, side, side, radius * side, IS_FIELD);

  const box = mark * side;
  const left = (side - box) / 2;
  const middle = side / 2;
  BAR_HEIGHTS.forEach((height, i) => {
    const x0 = left + i * (BAR_WIDTH + BAR_GAP) * box;
    const half = (height * box) / 2;
    fillRoundRect(
      samples,
      side,
      x0,
      middle - half,
      x0 + BAR_WIDTH * box,
      middle + half,
      (BAR_WIDTH * box) / 2,
      IS_MARK,
    );
  });

  // The box-downsample, averaging in premultiplied terms: an uncovered sample
  // contributes to alpha and to nothing else. Averaging straight RGBA instead would
  // drag every edge pixel towards black, and the tile would ship with a dark fringe.
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let field = 0;
      let inked = 0;
      for (let sy = 0; sy < SS; sy++) {
        const row = (y * SS + sy) * side + x * SS;
        for (let sx = 0; sx < SS; sx++) {
          const sample = samples[row + sx];
          if (sample === IS_FIELD) field++;
          else if (sample === IS_MARK) inked++;
        }
      }
      const covered = field + inked;
      if (covered === 0) continue;
      const at = (y * size + x) * 4;
      rgba[at] = Math.round((field * FIELD.r + inked * MARK.r) / covered);
      rgba[at + 1] = Math.round((field * FIELD.g + inked * MARK.g) / covered);
      rgba[at + 2] = Math.round((field * FIELD.b + inked * MARK.b) / covered);
      rgba[at + 3] = Math.round((covered * 255) / (SS * SS));
    }
  }
  return png(size, rgba);
}

/** PNG's CRC-32, which is the ordinary one with the ordinary reversed polynomial. */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  const framed = Buffer.alloc(body.length + 8);
  framed.writeUInt32BE(data.length, 0);
  body.copy(framed, 4);
  framed.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return framed;
}

/**
 * 8-bit RGBA, no interlacing, and filter 0 on every scanline. A per-row filter would
 * compress this better in general; for flat colour it would not, because a run of
 * identical bytes is already the one thing deflate is best at.
 */
function png(size: number, rgba: Uint8Array): Buffer {
  const stride = size * 4;
  const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++)
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * The maskable one keeps its artwork inside 0.56 of the width, which is the largest
 * square that fits in the 80%-diameter circle a maskable icon is promised — anything
 * larger is a bar Android is allowed to crop. The other two round their own corners,
 * so their mark can afford to be a touch smaller and still look the same size.
 */
const ICONS = [
  { file: "icon-192.png", size: 192, radius: 0.225, mark: 0.54 },
  { file: "icon-512.png", size: 512, radius: 0.225, mark: 0.54 },
  { file: "icon-512-maskable.png", size: 512, radius: 0, mark: 0.56 },
  { file: "apple-touch-icon.png", size: 180, radius: 0, mark: 0.58 },
];

await mkdir(publicDir, { recursive: true });
const written: string[] = [];
for (const { file, size, radius, mark } of ICONS) {
  await writeFile(path.join(publicDir, file), icon(size, radius, mark));
  written.push(`${file} (${(await stat(path.join(publicDir, file))).size} bytes)`);
}
console.log(`wrote ${written.join(", ")} into src/web/public`);
