// QuickTime (.mov) writer and reader for Photo-JPEG ('jpeg') video, no dependencies. Variable frame rate: each unique
// frame is stored once with its own duration (stts), so still stretches cost nothing. QuickTime Player and AVFoundation
// open it natively, which the AVI may not do on recent macOS.
// Layout: ftyp, mdat (the JPEGs back to back), moov { mvhd, trak { tkhd, mdia { mdhd, hdlr, minf { vmhd, hdlr, dinf, stbl } } } }.
import { closeSync, openSync, readSync, fstatSync, writeSync } from "node:fs";
import { jpegSize, looksLikeJpeg } from "./jpeg.mjs";

const TIMESCALE = 1000; // milliseconds
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const zeros = (n) => Buffer.alloc(n);
const str = (s) => Buffer.from(s, "latin1");
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), str(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version), Buffer.from([(flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
const matrix = () => Buffer.concat(MATRIX.map(u32));
const pascal = (s, size) => { const b = Buffer.alloc(size); b[0] = s.length; b.write(s, 1, "latin1"); return b; };

/**
 * Writes `samples` ([{ data: JPEG Buffer, durationMs }]) as a .mov. Returns { bytes, frames, width, height, durationMs }.
 */
export function writeMov(path, samples) {
  if (!samples.length) throw new Error("writeMov: no samples");
  const size = jpegSize(samples[0].data);
  if (!size) throw new Error("writeMov: first sample is not a JPEG");
  const { width, height } = size;
  const durations = samples.map((s) => Math.max(1, Math.round(s.durationMs)));
  const total = durations.reduce((a, b) => a + b, 0);

  const fd = openSync(path, "w");
  let pos = 0;
  const put = (b) => { writeSync(fd, b, 0, b.length, pos); pos += b.length; };
  try {
    put(box("ftyp", str("qt  "), u32(0x200), str("qt  ")));
    const mdatPos = pos;
    put(Buffer.concat([u32(0), str("mdat")]));
    const offsets = [];
    for (const s of samples) {
      offsets.push(pos);
      put(s.data);
    }
    const mdatSize = pos - mdatPos;
    if (pos > 0xffffffff) throw new Error("writeMov: over 4 GiB; lower the quality");
    writeSync(fd, u32(mdatSize), 0, 4, mdatPos);

    // stts: run-length encode equal durations.
    const runs = [];
    for (const d of durations) {
      const last = runs[runs.length - 1];
      if (last && last[1] === d) last[0]++;
      else runs.push([1, d]);
    }
    const stsdEntry = box(
      "jpeg",
      zeros(6), u16(1), // reserved, data reference index
      u16(0), u16(0), str("appl"), u32(0), u32(0x200), // version, revision, vendor, temporal quality, spatial quality
      u16(width), u16(height), u32(72 << 16), u32(72 << 16), u32(0), u16(1), // dims, resolution, data size, frames per sample
      pascal("Photo - JPEG", 32), u16(24), u16(0xffff), // compressor name, depth, color table id (-1: none)
    );
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), stsdEntry),
      full("stts", 0, 0, u32(runs.length), ...runs.flatMap(([n, d]) => [u32(n), u32(d)])),
      full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
      full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
      full("stco", 0, 0, u32(offsets.length), ...offsets.map(u32)),
    );
    const minf = box(
      "minf",
      full("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
      full("hdlr", 0, 0, str("dhlr"), str("alis"), u32(0), u32(0), u32(0), pascal("Apple Alias Data Handler", 25)),
      box("dinf", full("dref", 0, 0, u32(1), full("alis", 0, 1))),
      stbl,
    );
    const mdia = box(
      "mdia",
      full("mdhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(total), u16(0), u16(0)),
      full("hdlr", 0, 0, str("mhlr"), str("vide"), u32(0), u32(0), u32(0), pascal("Apple Video Media Handler", 26)),
      minf,
    );
    const tkhd = full("tkhd", 0, 0x3, u32(0), u32(0), u32(1), u32(0), u32(total), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix(), u32(width << 16), u32(height << 16));
    const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(total), u32(0x00010000), u16(0x0100), zeros(10), matrix(), zeros(24), u32(2));
    put(box("moov", mvhd, box("trak", tkhd, mdia)));
  } finally {
    closeSync(fd);
  }
  return { bytes: pos, frames: samples.length, width, height, durationMs: total };
}

/**
 * Parses a .mov written by writeMov and checks it: top-level boxes tile the file, stsz/stco/stts agree on the sample
 * count, every chunk offset lands inside mdat on a JPEG of the stated size. Returns { width, height, frames, durationSeconds, codec, errors }.
 */
export function readMov(path) {
  const fd = openSync(path, "r");
  const errors = [];
  try {
    const size = fstatSync(fd).size;
    const at = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
    const top = new Map();
    for (let p = 0; p < size; ) {
      const h = at(p, 8);
      const len = h.readUInt32BE(0), type = h.toString("latin1", 4, 8);
      if (len < 8 || p + len > size) { errors.push(`box ${type} at ${p} has bad size ${len}`); break; }
      top.set(type, { pos: p, len });
      p += len;
    }
    for (const t of ["ftyp", "mdat", "moov"]) if (!top.has(t)) errors.push(`missing ${t}`);
    if (!top.has("moov") || !top.has("mdat")) return { errors };
    const moov = at(top.get("moov").pos, top.get("moov").len);
    const find = (buf, path) => {
      let start = 8, end = buf.length, found = null;
      for (const want of path) {
        found = null;
        for (let p = start; p + 8 <= end; ) {
          const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
          if (len < 8) break;
          if (type === want) { found = { s: p, e: p + len }; break; }
          p += len;
        }
        if (!found) return null;
        start = found.s + 8; end = found.e;
      }
      return found ? buf.subarray(found.s, found.e) : null;
    };
    const mvhd = find(moov, ["mvhd"]);
    const stbl = ["trak", "mdia", "minf", "stbl"];
    const stsd = find(moov, [...stbl, "stsd"]), stts = find(moov, [...stbl, "stts"]), stsz = find(moov, [...stbl, "stsz"]), stco = find(moov, [...stbl, "stco"]);
    const tkhd = find(moov, ["trak", "tkhd"]);
    if (!mvhd || !stsd || !stts || !stsz || !stco || !tkhd) { errors.push("missing mvhd/tkhd/stsd/stts/stsz/stco"); return { errors }; }
    const timescale = mvhd.readUInt32BE(20), duration = mvhd.readUInt32BE(24);
    const codec = stsd.toString("latin1", 20, 24);
    const width = stsd.readUInt16BE(16 + 8 + 24), height = stsd.readUInt16BE(16 + 8 + 26);
    const n = stsz.readUInt32BE(16);
    let sttsCount = 0, sttsTotal = 0;
    for (let i = 0, k = stts.readUInt32BE(12); i < k; i++) { const c = stts.readUInt32BE(16 + i * 8), d = stts.readUInt32BE(20 + i * 8); sttsCount += c; sttsTotal += c * d; }
    if (sttsCount !== n) errors.push(`stts covers ${sttsCount} samples, stsz has ${n}`);
    if (sttsTotal !== duration) errors.push(`stts duration ${sttsTotal} != mvhd duration ${duration}`);
    if (stco.readUInt32BE(12) !== n) errors.push(`stco has ${stco.readUInt32BE(12)} chunks, stsz has ${n}`);
    const mdat = top.get("mdat");
    for (let i = 0; i < n; i++) {
      const off = stco.readUInt32BE(16 + i * 4), len = stsz.readUInt32BE(20 + i * 4);
      if (off < mdat.pos + 8 || off + len > mdat.pos + mdat.len) { errors.push(`sample ${i} lies outside mdat`); break; }
      if (i === 0 || i === n - 1 || i % 50 === 0) {
        const data = at(off, len);
        if (!looksLikeJpeg(data)) { errors.push(`sample ${i} is not a complete JPEG`); break; }
        const s = jpegSize(data);
        if (!s || s.width !== width || s.height !== height) { errors.push(`sample ${i} is ${s?.width}x${s?.height}, stsd says ${width}x${height}`); break; }
      }
    }
    return { width, height, frames: n, durationSeconds: duration / timescale, codec, bytes: size, errors };
  } finally {
    closeSync(fd);
  }
}
