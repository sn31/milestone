// MJPEG-in-AVI writer and reader, no dependencies. One video stream ('vids'/'MJPG'), constant frame rate, an idx1 index.
// Layout: RIFF 'AVI ' { LIST 'hdrl' { avih, LIST 'strl' { strh, strf } }, LIST 'movi' { '00dc'... }, idx1 }.
// Plain RIFF (no OpenDML), so the file must stay under 1 GiB; writeAvi refuses past that.
import { closeSync, openSync, readSync, fstatSync, writeSync } from "node:fs";
import { jpegSize, looksLikeJpeg } from "./jpeg.mjs";

const LIMIT = 1024 * 1024 * 1024 - 1024 * 1024; // keep clear of the 1 GiB RIFF limit
const AVIF_HASINDEX = 0x10;
const AVIIF_KEYFRAME = 0x10;

const fourcc = (s) => Buffer.from(s, "latin1");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/**
 * Writes `frames` (an array of JPEG Buffers, or of indexes into `pool` when `pool` is given, so repeated frames are
 * stored once in memory) to `path` at `fps`. Every frame must have the same dimensions. Returns { bytes, frames, width, height }.
 */
export function writeAvi(path, { fps, frames, pool = null }) {
  if (!frames.length) throw new Error("writeAvi: no frames");
  const get = (i) => (pool ? pool[frames[i]] : frames[i]);
  const size = jpegSize(get(0));
  if (!size) throw new Error("writeAvi: first frame is not a JPEG");
  const { width, height } = size;
  let maxChunk = 0;
  for (let i = 0; i < frames.length; i++) maxChunk = Math.max(maxChunk, get(i).length);

  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(Math.round(1e6 / fps), 0); // dwMicroSecPerFrame
  avih.writeUInt32LE(maxChunk * Math.ceil(fps), 4); // dwMaxBytesPerSec
  avih.writeUInt32LE(0, 8); // dwPaddingGranularity
  avih.writeUInt32LE(AVIF_HASINDEX, 12); // dwFlags
  avih.writeUInt32LE(frames.length, 16); // dwTotalFrames
  avih.writeUInt32LE(0, 20); // dwInitialFrames
  avih.writeUInt32LE(1, 24); // dwStreams
  avih.writeUInt32LE(maxChunk + 8, 28); // dwSuggestedBufferSize
  avih.writeUInt32LE(width, 32);
  avih.writeUInt32LE(height, 36);

  const strh = Buffer.alloc(56);
  fourcc("vids").copy(strh, 0);
  fourcc("MJPG").copy(strh, 4);
  strh.writeUInt32LE(0, 8); // dwFlags
  strh.writeUInt16LE(0, 12); // wPriority
  strh.writeUInt16LE(0, 14); // wLanguage
  strh.writeUInt32LE(0, 16); // dwInitialFrames
  strh.writeUInt32LE(1000, 20); // dwScale
  strh.writeUInt32LE(Math.round(fps * 1000), 24); // dwRate (rate/scale = fps)
  strh.writeUInt32LE(0, 28); // dwStart
  strh.writeUInt32LE(frames.length, 32); // dwLength
  strh.writeUInt32LE(maxChunk + 8, 36); // dwSuggestedBufferSize
  strh.writeInt32LE(-1, 40); // dwQuality
  strh.writeUInt32LE(0, 44); // dwSampleSize
  strh.writeInt16LE(0, 48); strh.writeInt16LE(0, 50); strh.writeInt16LE(width, 52); strh.writeInt16LE(height, 54); // rcFrame

  const strf = Buffer.alloc(40); // BITMAPINFOHEADER
  strf.writeUInt32LE(40, 0);
  strf.writeInt32LE(width, 4);
  strf.writeInt32LE(height, 8);
  strf.writeUInt16LE(1, 12); // planes
  strf.writeUInt16LE(24, 14); // bit count
  fourcc("MJPG").copy(strf, 16);
  strf.writeUInt32LE(width * height * 3, 20);

  const chunk = (id, data) => Buffer.concat([fourcc(id), u32(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const list = (type, parts) => { const body = Buffer.concat([fourcc(type), ...parts]); return Buffer.concat([fourcc("LIST"), u32(body.length), body]); };
  const hdrl = list("hdrl", [chunk("avih", avih), list("strl", [chunk("strh", strh), chunk("strf", strf)])]);

  const fd = openSync(path, "w");
  let pos = 0;
  const put = (b) => { writeSync(fd, b, 0, b.length, pos); pos += b.length; };
  try {
    put(Buffer.concat([fourcc("RIFF"), u32(0), fourcc("AVI ")]));
    put(hdrl);
    const moviListPos = pos;
    put(Buffer.concat([fourcc("LIST"), u32(0), fourcc("movi")]));
    const moviTypePos = moviListPos + 8; // idx1 offsets are relative to the 'movi' fourcc
    const index = Buffer.alloc(16 * frames.length);
    for (let i = 0; i < frames.length; i++) {
      const data = get(i);
      const offset = pos - moviTypePos;
      put(chunk("00dc", data));
      fourcc("00dc").copy(index, i * 16);
      index.writeUInt32LE(AVIIF_KEYFRAME, i * 16 + 4);
      index.writeUInt32LE(offset, i * 16 + 8);
      index.writeUInt32LE(data.length, i * 16 + 12);
      if (pos > LIMIT) throw new Error(`writeAvi: over 1 GiB at frame ${i}; lower the quality or the frame rate`);
    }
    const moviEnd = pos;
    put(chunk("idx1", index));
    writeSync(fd, u32(moviEnd - moviListPos - 8), 0, 4, moviListPos + 4);
    writeSync(fd, u32(pos - 8), 0, 4, 4);
  } finally {
    closeSync(fd);
  }
  return { bytes: pos, frames: frames.length, width, height };
}

/**
 * Parses an AVI written by writeAvi (or any simple single-stream MJPEG AVI) and checks it: RIFF sizes match the file,
 * hdrl/avih/strl/strh/strf are present, every idx1 entry points at a '00dc' chunk of the stated length holding a JPEG,
 * and the counts agree. Returns { width, height, fps, frames, durationSeconds, codec, errors }.
 */
export function readAvi(path) {
  const fd = openSync(path, "r");
  const errors = [];
  try {
    const size = fstatSync(fd).size;
    const at = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
    const head = at(0, 12);
    if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "AVI ") throw new Error("not a RIFF AVI file");
    if (head.readUInt32LE(4) + 8 !== size) errors.push(`RIFF size ${head.readUInt32LE(4) + 8} != file size ${size}`);
    let avih = null, strh = null, strf = null, movi = null, idx1 = null;
    const walk = (start, end, depth) => {
      let p = start;
      while (p + 8 <= end) {
        const h = at(p, 12);
        const id = h.toString("latin1", 0, 4);
        const len = h.readUInt32LE(4);
        if (p + 8 + len > end) { errors.push(`chunk ${id} at ${p} overruns its parent`); return; }
        if (id === "LIST") {
          const type = h.toString("latin1", 8, 12);
          if (type === "movi") movi = { typePos: p + 8, start: p + 12, end: p + 8 + len };
          else if (depth < 3) walk(p + 12, p + 8 + len, depth + 1);
        } else if (id === "avih") avih = at(p + 8, len);
        else if (id === "strh") strh = at(p + 8, len);
        else if (id === "strf") strf = at(p + 8, len);
        else if (id === "idx1") idx1 = { pos: p + 8, len };
        p += 8 + len + (len % 2);
      }
    };
    walk(12, size, 0);
    if (!avih) errors.push("missing avih");
    if (!strh) errors.push("missing strh");
    if (!strf) errors.push("missing strf");
    if (!movi) errors.push("missing LIST movi");
    if (!idx1) errors.push("missing idx1");
    if (errors.length && (!avih || !strh || !movi)) return { errors };
    const width = avih.readUInt32LE(32), height = avih.readUInt32LE(36);
    const totalFrames = avih.readUInt32LE(16);
    const fps = strh.readUInt32LE(24) / strh.readUInt32LE(20);
    const codec = strh.toString("latin1", 4, 8);
    if (strh.toString("latin1", 0, 4) !== "vids") errors.push("stream is not 'vids'");
    if (strf && strf.toString("latin1", 16, 20) !== "MJPG") errors.push("strf compression is not MJPG");
    if (strh.readUInt32LE(32) !== totalFrames) errors.push(`strh dwLength ${strh.readUInt32LE(32)} != avih dwTotalFrames ${totalFrames}`);
    // movi chunks
    let chunks = 0;
    for (let p = movi.start; p + 8 <= movi.end; ) {
      const h = at(p, 8);
      const id = h.toString("latin1", 0, 4), len = h.readUInt32LE(4);
      if (id === "00dc") chunks++;
      p += 8 + len + (len % 2);
    }
    if (chunks !== totalFrames) errors.push(`movi holds ${chunks} 00dc chunks, header says ${totalFrames}`);
    if (idx1) {
      const n = idx1.len / 16;
      if (n !== totalFrames) errors.push(`idx1 has ${n} entries, header says ${totalFrames}`);
      const index = at(idx1.pos, idx1.len);
      for (let i = 0; i < n; i++) {
        const id = index.toString("latin1", i * 16, i * 16 + 4);
        const off = index.readUInt32LE(i * 16 + 8), len = index.readUInt32LE(i * 16 + 12);
        const h = at(movi.typePos + off, 8);
        if (id !== "00dc" || h.toString("latin1", 0, 4) !== "00dc" || h.readUInt32LE(4) !== len) { errors.push(`idx1 entry ${i} does not match its chunk`); break; }
        // Check the JPEG payload of a sample of frames (first, last and every 50th).
        if (i === 0 || i === n - 1 || i % 50 === 0) {
          const data = at(movi.typePos + off + 8, len);
          if (!looksLikeJpeg(data)) { errors.push(`frame ${i} is not a complete JPEG`); break; }
          const s = jpegSize(data);
          if (!s || s.width !== width || s.height !== height) { errors.push(`frame ${i} is ${s?.width}x${s?.height}, header says ${width}x${height}`); break; }
        }
      }
    }
    return { width, height, fps, frames: totalFrames, durationSeconds: totalFrames / fps, codec, bytes: size, errors };
  } finally {
    closeSync(fd);
  }
}
