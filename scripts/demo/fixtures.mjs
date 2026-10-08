// Files the freelancer uploads in the bakery beat: a 1200 px PNG logo and a two-page PDF style guide with a
// Typography section, which pass the seeded upload criteria for mst_brand_1. Pure Node, no image libraries.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
};

/** A 1200x800 RGB PNG: a crust-coloured disc with a flour-coloured ring on a cream ground. */
export function bakeryLogoPng(W = 1200, H = 800) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const [r, g, b] = d < 230 ? [196, 120, 60] : d < 262 ? [250, 240, 225] : d < 270 ? [196, 120, 60] : [250, 244, 232];
      const i = row + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A two-page PDF with uncompressed text (so the page count and the "Typography" heading are checkable). */
export function styleGuidePdf() {
  const pages = [
    "Bakery Style Guide - Colour: warm crust #C4783C, flour #FAF0E1, rye #5A3A22",
    "Typography: headings in a rounded serif, body in a humanist sans at 16px",
  ];
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((t, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    const s = `BT /F1 14 Tf 72 700 Td (${t}) Tj ET`;
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Writes both files into `dir` and returns their absolute paths. */
export function writeUploadFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const logo = join(dir, "bakery-logo.png");
  const guide = join(dir, "style-guide.pdf");
  writeFileSync(logo, bakeryLogoPng());
  writeFileSync(guide, styleGuidePdf());
  return [logo, guide];
}
