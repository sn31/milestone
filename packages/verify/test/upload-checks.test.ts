import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CriterionSpec } from "@milestone/core";
import { countWords, docxText, jpegSize, patternMatcher, pdfPageCount, pdfText, pngSize, runUploadStage, sniffFormat } from "../src/upload-checks.js";
import { toolResultContent } from "../src/llm.js";

// ---------- fixtures, generated ----------

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A valid grayscale PNG of the given size. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((width + 1) * height); // filter byte + pixels, all zero
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** SOI, APP0 (JFIF), SOF0 with the size, EOI: enough for a header parser. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** A minimal PDF with one content stream per page; compressed streams when `flate`. */
function pdf(pages: string[], flate = false): Buffer {
  const objs: string[] = [];
  const bin: Array<Buffer | null> = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  bin.push(null, null);
  pages.forEach((text, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`);
    bin.push(null);
    const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, "latin1");
    const body = flate ? deflateSync(content) : content;
    objs.push(`<< /Length ${body.length}${flate ? " /Filter /FlateDecode" : ""} >>`);
    bin.push(body);
  });
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  objs.forEach((o, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\n`, "latin1"));
    if (bin[i]) parts.push(Buffer.from("stream\n"), bin[i]!, Buffer.from("\nendstream\n"));
    parts.push(Buffer.from("endobj\n"));
  });
  parts.push(Buffer.from("trailer << /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

/** A zip with deflated entries (enough of the format for docx). */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const comp = deflateRawSync(data);
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, comp);
    centrals.push(central, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const count = Object.keys(entries).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`).join("");
  return zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
  });
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const crit = (id: string, spec: Record<string, unknown>, kind: CriterionSpec["kind"] = "upload"): CriterionSpec => ({ id, kind, description: id, spec, required: true });
const statusOf = (ev: Awaited<ReturnType<typeof runUploadStage>>["evidence"], id: string) => ev.find((e) => e.criterion_id === id)?.status;

// ---------- unit ----------

describe("sniffing and headers", () => {
  it("recognises formats by magic bytes, not by name", () => {
    expect(sniffFormat(png(4, 4), "logo.jpg")).toBe("png");
    expect(sniffFormat(jpeg(10, 10), "x.png")).toBe("jpg");
    expect(sniffFormat(pdf(["Hi"]), "a.txt")).toBe("pdf");
    expect(sniffFormat(docx(["Hello"]), "a.docx")).toBe("docx");
    expect(sniffFormat(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), "a")).toBe("svg");
    expect(sniffFormat(Buffer.from("# Title\n"), "a.md")).toBe("md");
    expect(sniffFormat(Buffer.from("plain"), "a.md.txt")).toBe("txt");
    expect(sniffFormat(Buffer.from([0x00, 0x01, 0xfe]), "a.txt")).toBeNull();
    expect(sniffFormat(zip({ "a.txt": "x" }), "fake.docx")).toBeNull();
  });
  it("reads PNG and JPEG dimensions", () => {
    expect(pngSize(png(1200, 3))).toEqual({ width: 1200, height: 3 });
    expect(jpegSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it("counts PDF pages and extracts simple text, compressed or not", () => {
    expect(pdfPageCount(pdf(["a", "b", "c"]))).toBe(3);
    expect(pdfPageCount(pdf(["a", "b"], true))).toBe(2);
    expect(pdfText(pdf(["Typography rules"], true))).toContain("Typography rules");
    expect(pdfText(pdf(["Escaped \\(paren\\)"]))).toContain("Escaped (paren)");
  });
  it("reads docx body text with a minimal zip reader", () => {
    const t = docxText(docx(["About us", "We bake & sell bread."]));
    expect(t).toContain("About us");
    expect(t).toContain("We bake & sell bread.");
    expect(countWords(t!)).toBe(6); // "&" is not a word
  });
  it("matches globs and extension lists", () => {
    expect(patternMatcher("*.{svg,png}")("Logo.PNG")).toBe(true);
    expect(patternMatcher("*.{svg,png}")("logo.jpg")).toBe(false);
    expect(patternMatcher("svg,png")("a.svg")).toBe(true);
    expect(patternMatcher([".md", ".docx"])("copy.docx")).toBe(true);
    expect(patternMatcher("logo-*.png")("logo-dark.png")).toBe(true);
    expect(patternMatcher("logo-*.png")("other.png")).toBe(false);
  });
});

describe("runUploadStage", () => {
  const files = [
    { name: "logo.png", size: 0, sha256: "a".repeat(64), bytes: png(1024, 256) },
    { name: "small.png", size: 0, bytes: png(64, 64) },
    { name: "style-guide.pdf", size: 0, bytes: pdf(["Colour", "Typography", "Logo use"], true) },
    { name: "copy.md", size: 0, bytes: Buffer.from(`# About us\n\n${words(650)}\n`) },
    { name: "copy.docx", size: 0, bytes: docx(["About us", words(10)]) },
  ].map((f) => ({ ...f, size: f.bytes.length }));

  it("passes, fails and leaves unclear per criterion, with one evidence item per file", async () => {
    const criteria = [
      crit("logo", { pattern: "*.{svg,png}", minWidth: 1024 }),
      crit("logo-huge", { pattern: "*.png", minWidth: 4096 }),
      crit("guide", { pattern: "*.pdf", format: "pdf", maxPages: 12, mustContain: ["typography"] }),
      crit("guide-short", { pattern: "*.pdf", maxPages: 2 }),
      crit("copy", { pattern: ".md,.docx", minWords: 600, mustContain: ["About us"] }),
      crit("copy-docx", { pattern: "*.docx", format: "docx", minWords: 600 }),
      crit("missing", { pattern: "*.svg" }),
      crit("guide-absent-word", { pattern: "*.pdf", mustContain: ["Iconography"] }),
      crit("bad-spec", { minWidth: 3 }),
      crit("readme", { path: "copy.md" }, "file"),
      crit("tests", { command: "npm test" }, "test"),
    ];
    const { evidence, inspections } = await runUploadStage({ files, criteria });
    expect(inspections.map((i) => i.format)).toEqual(["png", "png", "pdf", "md", "docx"]);
    expect(evidence.filter((e) => e.id.startsWith("evd_file_")).map((e) => e.id)).toEqual(["evd_file_1", "evd_file_2", "evd_file_3", "evd_file_4", "evd_file_5"]);
    expect(evidence.find((e) => e.id === "evd_file_1")?.status).toBeUndefined();
    expect(statusOf(evidence, "logo")).toBe("pass");
    expect(evidence.find((e) => e.criterion_id === "logo")).toMatchObject({ uri: "evd_file_1", sha256: "a".repeat(64) });
    expect(statusOf(evidence, "logo-huge")).toBe("fail");
    expect(statusOf(evidence, "guide")).toBe("pass");
    expect(statusOf(evidence, "guide-short")).toBe("fail");
    expect(statusOf(evidence, "copy")).toBe("pass");
    expect(statusOf(evidence, "copy-docx")).toBe("fail");
    expect(statusOf(evidence, "missing")).toBe("fail");
    // little extractable PDF text: not finding a word is unclear, not fail
    expect(statusOf(evidence, "guide-absent-word")).toBe("unclear");
    expect(statusOf(evidence, "bad-spec")).toBe("unclear");
    expect(statusOf(evidence, "readme")).toBe("pass");
    expect(statusOf(evidence, "tests")).toBe("unclear");
  });

  it("treats a vector SVG as wide enough and a mislabelled file by its bytes", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text>Crumb</text></svg>');
    const fake = Buffer.from("not really a png");
    const { evidence } = await runUploadStage({
      files: [{ name: "logo.svg", size: svg.length, bytes: svg }, { name: "fake.png", size: fake.length, bytes: fake }],
      criteria: [crit("svg", { pattern: "*.svg", minWidth: 1024, mustContain: ["crumb"] }), crit("png", { pattern: "*.png", format: "png" })],
    });
    expect(statusOf(evidence, "svg")).toBe("pass");
    expect(statusOf(evidence, "png")).toBe("fail");
  });
});

describe("tool results", () => {
  it("wraps text as untrusted and builds image and document blocks", () => {
    expect(toolResultContent("hello")).toContain('untrusted="true"');
    const img = toolResultContent({ type: "image", mediaType: "image/png", base64: "AAAA" }) as Array<{ type: string }>;
    expect(img.map((b) => b.type)).toEqual(["text", "image"]);
    const doc = toolResultContent({ type: "document", mediaType: "application/pdf", base64: "AAAA" }) as Array<{ type: string; source?: { media_type: string } }>;
    expect(doc.map((b) => b.type)).toEqual(["text", "document"]);
    expect(doc[1]!.source!.media_type).toBe("application/pdf");
  });
});
