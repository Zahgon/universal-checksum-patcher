// Port of internal/core/pe.go — PE parsing, string anchoring, RVA mapping.

import { readFileSync } from 'node:fs';
import { newFile, sectionData } from '../internal/gope.js';
import { CoreError } from './pattern.js';
import { wrapFsError } from '../internal/goerrors.js';

// Go compares whole FnRange structs by value, including as map keys.
export function fnKey(fr) {
  return `${fr.begin}:${fr.end}`;
}

function indexOfBytes(haystack, needle) {
  if (needle.length === 0) return 0;
  const limit = haystack.length - needle.length;
  const first = needle[0];
  outer: for (let i = 0; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

export class Image {
  constructor({ path, raw, base, ptrSize, machine, sections, pdata }) {
    this.path = path;
    this.raw = raw;
    this.base = base;
    this.ptrSize = ptrSize;
    this.machine = machine;
    this.sections = sections;
    this.pdata = pdata;
    this.leaCache = null;
  }

  isX64() {
    return this.ptrSize === 8;
  }

  section(name) {
    for (const s of this.sections) {
      if (s.name === name) return s;
    }
    return null;
  }

  text() {
    return this.section('.text');
  }

  // bytes returns a view into raw, so writes through it alias the image —
  // matching Go's slice semantics, which the transactional patch path relies on.
  bytes(s) {
    if (s.fileOff > this.raw.length) return null;
    let end = s.fileOff + s.rawSize;
    if (end > this.raw.length) end = this.raw.length;
    return this.raw.subarray(s.fileOff, end);
  }

  sectionForRVA(rva) {
    for (const s of this.sections) {
      if (rva >= s.rva && rva < ((s.rva + s.vSize) >>> 0)) return s;
    }
    return null;
  }

  rvaToFileOff(rva) {
    const s = this.sectionForRVA(rva);
    if (s === null) return { off: 0, ok: false };
    const off = ((rva - s.rva) >>> 0) + s.fileOff;
    if (off < 0 || off >= this.raw.length) return { off: 0, ok: false };
    return { off, ok: true };
  }

  // funcContains mirrors sort.Search: the smallest index whose End > rva.
  funcContains(rva) {
    let lo = 0;
    let hi = this.pdata.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.pdata[mid].end > rva) hi = mid;
      else lo = mid + 1;
    }
    if (lo < this.pdata.length && rva >= this.pdata[lo].begin && rva < this.pdata[lo].end) {
      return { fr: this.pdata[lo], in: true };
    }
    return { fr: { begin: 0, end: 0 }, in: false };
  }

  // stringVAs returns the VAs of every occurrence of s that begins a
  // null-terminated string.
  //
  // UPSTREAM DEFECT: with an empty needle, bytes.Index always returns 0, so the
  // cursor walks one past the end of the section and Go panics on data[i:].
  // Reachable as `toolkit anchor <exe> ""`. Preserved verbatim rather than
  // fixed, because the Go original is the authority on behaviour.
  stringVAs(s) {
    const needle = new TextEncoder().encode(s);
    const out = [];
    for (const sec of this.sections) {
      const data = this.bytes(sec);
      if (data === null) continue;
      for (let i = 0; ;) {
        if (i > data.length) {
          throw new RangeError(`runtime error: slice bounds out of range [${i}:${data.length}]`);
        }
        const j = indexOfBytes(data.subarray(i), needle);
        if (j < 0) break;
        const at = i + j;
        if (at === 0 || data[at - 1] === 0) {
          out.push(this.base + sec.rva + at);
        }
        i = at + 1;
      }
    }
    return out;
  }

  // buildLeaCache precomputes every `lea r64,[rip+disp32]` site in .text with its
  // resolved target VA. Go recomputes this scan per lookup; caching is a pure
  // optimization with identical results.
  //
  // A negative targetRVA makes Go's uint64 addition wrap to a value above every
  // real target VA, so such sites can never match and are recorded as -1.
  buildLeaCache() {
    if (this.leaCache !== null) return this.leaCache;
    const text = this.text();
    if (text === null || !this.isX64()) {
      this.leaCache = [];
      return this.leaCache;
    }
    const d = this.bytes(text);
    if (d === null) {
      this.leaCache = [];
      return this.leaCache;
    }
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const cache = [];
    for (let i = 0; i + 7 <= d.length; i++) {
      const b = d[i];
      if (b !== 0x48 && b !== 0x49 && b !== 0x4c && b !== 0x4d) continue;
      if (d[i + 1] !== 0x8d || (d[i + 2] & 0xc7) !== 0x05) continue;
      const disp = view.getInt32(i + 3, true);
      const targetRVA = text.rva + i + 7 + disp;
      const targetVA = targetRVA < 0 ? -1 : this.base + targetRVA;
      cache.push({ site: (text.rva + i) >>> 0, targetVA });
    }
    this.leaCache = cache;
    return cache;
  }

  leaXrefRVAs(targetVA) {
    const out = [];
    for (const e of this.buildLeaCache()) {
      if (e.targetVA === targetVA) out.push(e.site);
    }
    return out;
  }

  funcsReferencingString(anchor) {
    const seen = new Set();
    const out = [];
    for (const va of this.stringVAs(anchor)) {
      for (const site of this.leaXrefRVAs(va)) {
        const { fr, in: inFunc } = this.funcContains(site);
        if (inFunc && !seen.has(fnKey(fr))) {
          seen.add(fnKey(fr));
          out.push(fr);
        }
      }
    }
    return out;
  }
}

export function openImage(path) {
  let raw;
  try {
    raw = new Uint8Array(readFileSync(path));
  } catch (err) {
    throw new CoreError(`read ${path}: ${wrapFsError(err, path)}`, err);
  }

  let f;
  try {
    f = newFile(raw);
  } catch (err) {
    // Go wraps every error pe.NewFile returns, including the bare strconv and
    // string-table errors raised while resolving section and symbol names.
    throw new CoreError(`parse PE ${path}: ${err.message}`, err);
  }

  const oh = f.optionalHeader;
  let base;
  let ptrSize;
  if (oh !== null && oh.is64) {
    base = oh.imageBase;
    ptrSize = 8;
  } else if (oh !== null && !oh.is64) {
    base = oh.imageBase;
    ptrSize = 4;
  } else {
    throw new CoreError(`${path}: unrecognised optional header`);
  }

  const sections = f.sections.map((ps) => ({
    name: ps.name,
    rva: ps.virtualAddress,
    vSize: ps.virtualSize,
    fileOff: ps.offset,
    rawSize: ps.size,
  }));

  const pdata = [];
  const pd = f.sections.find((s) => s.name === '.pdata') ?? null;
  if (pd !== null) {
    const d = sectionData(f, pd);
    if (d !== null) {
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      for (let off = 0; off + 12 <= d.length; off += 12) {
        const begin = view.getUint32(off, true);
        const end = view.getUint32(off + 4, true);
        if (begin < end) pdata.push({ begin, end });
      }
      pdata.sort((a, b) => a.begin - b.begin);
    }
  }

  return new Image({ path, raw, base, ptrSize, machine: f.fileHeader.machine, sections, pdata });
}
