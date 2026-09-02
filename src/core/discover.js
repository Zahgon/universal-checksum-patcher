// Port of internal/core/discover.go

import { findAll } from './pattern.js';
import { fnKey } from './image.js';

// findGates scans .text for the gate shape `test al/eax,self ; setz/setnz r8`
// and returns each hit inside a .pdata function, labelled with the strings that
// function references.
export function findGates(img, keywords) {
  const text = img.text();
  if (text === null) return [];
  const d = img.bytes(text);
  if (d === null) return [];
  const strCache = new Map();
  const out = [];
  for (let i = 0; i + 5 <= d.length; i++) {
    if (
      (d[i] === 0x84 || d[i] === 0x85) &&
      d[i + 1] === 0xc0 &&
      d[i + 2] === 0x0f &&
      (d[i + 3] === 0x94 || d[i + 3] === 0x95)
    ) {
      const rva = (text.rva + i) >>> 0;
      const { fr, in: inFunc } = img.funcContains(rva);
      if (!inFunc) continue;
      const key = fnKey(fr);
      let strs = strCache.get(key);
      if (strs === undefined) {
        strs = stringsInFunc(img, fr);
        strCache.set(key, strs);
      }
      if (keywords.length > 0 && !anyKeyword(strs, keywords)) continue;
      // The loop guard only requires i+5 <= len(d), but Go slices d[i:i+6].
      // Go's slice bound is the *capacity* of the .text subslice, which runs to
      // the end of the file, so the sixth byte is read from beyond the section
      // — and it panics only when .text ends at EOF. Clamping to the section
      // would silently return five bytes instead.
      const start = text.fileOff + i;
      if (start + 6 > img.raw.length) {
        throw new RangeError(
          `runtime error: slice bounds out of range [:6] with capacity ${img.raw.length - start}`,
        );
      }
      out.push({
        rva,
        func: fr,
        bytes: img.raw.slice(start, start + 6),
        strings: strs,
      });
    }
  }
  return out;
}

export function matchInText(img, p) {
  const text = img.text();
  if (text === null) return [];
  const d = img.bytes(text);
  if (d === null) return [];
  return findAll(p, d).map((off) => (text.rva + off) >>> 0);
}

// stringsInFunc returns distinct printable strings referenced by
// `lea r64,[rip]` inside a function.
export function stringsInFunc(img, fr) {
  const text = img.text();
  if (text === null) return [];
  const d = img.bytes(text);
  if (d === null) return [];
  const start = fr.begin - text.rva;
  const end = fr.end - text.rva;
  if (start < 0 || end > d.length || start >= end) return [];
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const seen = new Set();
  const out = [];
  for (let i = start; i + 7 <= end; i++) {
    if ((d[i] === 0x48 || d[i] === 0x4c) && d[i + 1] === 0x8d && (d[i + 2] & 0xc7) === 0x05) {
      const disp = view.getInt32(i + 3, true);
      const va = img.base + (text.rva + i + 7 + disp);
      const s = cStringAt(img, va);
      if (s.length >= 4 && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

// cStringAt reads a printable, null-terminated ASCII string at a VA.
export function cStringAt(img, va) {
  if (va < img.base) return '';
  // Go truncates the offset to uint32 here, which matters for a VA more than
  // 4 GiB above the image base.
  const rva = (va - img.base) >>> 0;
  const s = img.sectionForRVA(rva);
  if (s === null) return '';
  const data = img.bytes(s);
  if (data === null) return '';
  const off = rva - s.rva;
  if (off < 0 || off >= data.length) return '';
  let end = off;
  let out = '';
  while (end < data.length && data[end] !== 0 && end - off < 96) {
    const c = data[end];
    if (c < 0x20 || c > 0x7e) return '';
    out += String.fromCharCode(c);
    end++;
  }
  return out;
}

function anyKeyword(strs, keywords) {
  const blob = strs.join('\x00').toLowerCase();
  for (const k of keywords) {
    if (blob.includes(k.toLowerCase())) return true;
  }
  return false;
}
