// A faithful port of the subset of Go's `debug/pe` that this program observes.
// JavaScript has no PE parser, and the exact error strings and truncation
// behavior of debug/pe are externally visible through OpenImage.

import { atoi, bytesToGoString, hex2 } from './gostrconv.js';

export const IMAGE_FILE_MACHINE_UNKNOWN = 0x0;
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
export const IMAGE_FILE_MACHINE_ARMNT = 0x1c4;
export const IMAGE_FILE_MACHINE_I386 = 0x14c;
export const IMAGE_FILE_MACHINE_RISCV32 = 0x5032;
export const IMAGE_FILE_MACHINE_RISCV64 = 0x5064;
export const IMAGE_FILE_MACHINE_RISCV128 = 0x5128;

// The whitelist is Go 1.26's, which notably excludes LOONGARCH and ARM.
const ALLOWED_MACHINES = new Set([
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_ARM64,
  IMAGE_FILE_MACHINE_ARMNT,
  IMAGE_FILE_MACHINE_I386,
  IMAGE_FILE_MACHINE_RISCV32,
  IMAGE_FILE_MACHINE_RISCV64,
  IMAGE_FILE_MACHINE_RISCV128,
  IMAGE_FILE_MACHINE_UNKNOWN,
]);

const FILE_HEADER_SIZE = 20;
const SECTION_HEADER_SIZE = 40;
const COFF_SYMBOL_SIZE = 18;
const OH32_MIN_SIZE = 96;
const OH64_MIN_SIZE = 112;
const DATA_DIRECTORY_SIZE = 8;

export class PEError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PEError';
  }
}

// Mirrors the errors io.ReadFull surfaces through binary.Read.
const EOF = 'EOF';
const UNEXPECTED_EOF = 'unexpected EOF';

class Cursor {
  constructor(raw) {
    this.raw = raw;
    this.view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    this.pos = 0;
  }

  seek(off) {
    this.pos = off;
  }

  // need mirrors binary.Read's failure modes: EOF when nothing could be read,
  // unexpected EOF when the read was only partially satisfied.
  need(n) {
    if (this.pos < 0 || this.pos >= this.raw.length) {
      if (n > 0) throw new PEError(EOF);
      return;
    }
    if (this.pos + n > this.raw.length) throw new PEError(UNEXPECTED_EOF);
  }

  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u64() {
    this.need(8);
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    return hi * 0x100000000 + lo;
  }

  bytes(n) {
    this.need(n);
    const v = this.raw.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}

// Go's cstring does string(b), which keeps the bytes verbatim. Decoding them
// as latin1 would silently turn an invalid byte into a printable character and
// change how %q renders it.
function cstring(bytes) {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return bytesToGoString(bytes.subarray(0, end));
}

function readStringTable(fh, cur) {
  if (fh.pointerToSymbolTable <= 0) return null;
  const offset = (fh.pointerToSymbolTable + COFF_SYMBOL_SIZE * fh.numberOfSymbols) >>> 0;
  cur.seek(offset);
  let l;
  try {
    l = cur.u32();
  } catch (e) {
    throw new PEError(`fail to read string table length: ${e.message}`);
  }
  if (l <= 4) return null;
  l -= 4;
  try {
    return cur.bytes(l);
  } catch (e) {
    throw new PEError(`fail to read string table: ${e.message}`);
  }
}

function stringTableString(st, start) {
  if (start < 4) throw new PEError(`offset ${start} is before the start of string table`);
  start -= 4;
  const table = st ?? new Uint8Array(0);
  if (start > table.length) throw new PEError(`offset ${start} is beyond the end of string table`);
  return cstring(table.subarray(start));
}

// Only the two fields removeAuxSymbols consults are retained. Keeping a full
// object plus a name view per symbol costs an order of magnitude more memory
// than Go's packed struct and made a large symbol table exhaust the heap on
// files Go parses without difficulty.
function readCOFFSymbols(fh, cur) {
  if (fh.pointerToSymbolTable === 0) return [];
  if (fh.numberOfSymbols <= 0) return [];
  cur.seek(fh.pointerToSymbolTable);
  const syms = [];
  let naux = 0;
  for (let k = 0; k < fh.numberOfSymbols; k++) {
    try {
      cur.need(COFF_SYMBOL_SIZE);
      const nameIsOffset =
        cur.raw[cur.pos] === 0 && cur.raw[cur.pos + 1] === 0 &&
        cur.raw[cur.pos + 2] === 0 && cur.raw[cur.pos + 3] === 0;
      const nameOffset = cur.view.getUint32(cur.pos + 4, true);
      const numberOfAuxSymbols = cur.raw[cur.pos + 17];
      cur.pos += COFF_SYMBOL_SIZE;
      if (naux === 0) {
        naux = numberOfAuxSymbols;
        syms.push({ nameIsOffset, nameOffset, numberOfAuxSymbols });
      } else {
        naux--;
      }
    } catch (e) {
      throw new PEError(`fail to read symbol table: ${e.message}`);
    }
  }
  if (naux !== 0) {
    throw new PEError(`fail to read symbol table: ${naux} aux symbols unread`);
  }
  return syms;
}

// removeAuxSymbols resolves long symbol names through the string table. The
// symbols themselves are unused here, but its error path is reachable and
// observable through OpenImage, so it is reproduced.
function removeAuxSymbols(coffSymbols, st) {
  if (coffSymbols.length === 0) return;
  for (const sym of coffSymbols) {
    if (sym.nameIsOffset) stringTableString(st, sym.nameOffset);
  }
}

// The size check is an exact equality, which is also what bounds the loop below
// against a hostile NumberOfRvaAndSizes: n is pinned to sz/8, and sz is a uint16.
function readDataDirectories(cur, sz, n) {
  if (sz !== n * DATA_DIRECTORY_SIZE) {
    throw new PEError(
      `size of data directories(${sz}) is inconsistent with number of data directories(${n})`,
    );
  }
  const dd = [];
  try {
    // Go reads the whole array in one binary.Read, so a partial read is
    // "unexpected EOF" rather than the "EOF" a field-at-a-time loop would give.
    cur.need(n * DATA_DIRECTORY_SIZE);
    for (let i = 0; i < n; i++) {
      dd.push({ virtualAddress: cur.u32(), size: cur.u32() });
    }
  } catch (e) {
    throw new PEError(`failure to read data directories: ${e.message}`);
  }
  return dd;
}

function readOptionalHeader(cur, sz) {
  if (sz === 0) return null;
  if (sz < 2) throw new PEError('optional header size is less than optional header magic size');

  let magic;
  try {
    magic = cur.u16();
  } catch (e) {
    throw new PEError(`failure to read optional header magic: ${e.message}`);
  }

  if (magic === 0x10b) {
    if (sz < OH32_MIN_SIZE) {
      throw new PEError(
        `optional header size(${sz}) is less minimum size (${OH32_MIN_SIZE}) of PE32 optional header`,
      );
    }
    const oh = { magic, is64: false };
    try {
      cur.u8(); cur.u8();
      cur.u32(); cur.u32(); cur.u32(); cur.u32(); cur.u32();
      cur.u32();
      oh.imageBase = cur.u32();
      cur.u32(); cur.u32();
      cur.u16(); cur.u16(); cur.u16(); cur.u16(); cur.u16(); cur.u16();
      cur.u32(); cur.u32(); cur.u32(); cur.u32();
      cur.u16(); cur.u16();
      cur.u32(); cur.u32(); cur.u32(); cur.u32();
      cur.u32();
      oh.numberOfRvaAndSizes = cur.u32();
    } catch (e) {
      throw new PEError(`failure to read PE32 optional header: ${e.message}`);
    }
    oh.dataDirectory = readDataDirectories(cur, sz - OH32_MIN_SIZE, oh.numberOfRvaAndSizes);
    return oh;
  }

  if (magic === 0x20b) {
    if (sz < OH64_MIN_SIZE) {
      throw new PEError(
        `optional header size(${sz}) is less minimum size (${OH64_MIN_SIZE}) for PE32+ optional header`,
      );
    }
    const oh = { magic, is64: true };
    try {
      cur.u8(); cur.u8();
      cur.u32(); cur.u32(); cur.u32(); cur.u32(); cur.u32();
      oh.imageBase = cur.u64();
      cur.u32(); cur.u32();
      cur.u16(); cur.u16(); cur.u16(); cur.u16(); cur.u16(); cur.u16();
      cur.u32(); cur.u32(); cur.u32(); cur.u32();
      cur.u16(); cur.u16();
      cur.u64(); cur.u64(); cur.u64(); cur.u64();
      cur.u32();
      oh.numberOfRvaAndSizes = cur.u32();
    } catch (e) {
      throw new PEError(`failure to read PE32+ optional header: ${e.message}`);
    }
    oh.dataDirectory = readDataDirectories(cur, sz - OH64_MIN_SIZE, oh.numberOfRvaAndSizes);
    return oh;
  }

  throw new PEError(`optional header has unexpected Magic of 0x${magic.toString(16)}`);
}

function sectionFullName(nameBytes, st) {
  if (nameBytes[0] !== 0x2f) return cstring(nameBytes);
  const i = atoi(cstring(nameBytes.subarray(1)));
  // Go narrows to uint32 here, so a negative index wraps to a huge offset
  // rather than being reported as "before the start of string table".
  return stringTableString(st, i >>> 0);
}

// newFile mirrors pe.NewFile. `raw` is the entire file.
export function newFile(raw) {
  if (raw.length < 96) throw new PEError(EOF);
  const cur = new Cursor(raw);

  let base = 0;
  if (raw[0] === 0x4d && raw[1] === 0x5a) {
    const dosView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const signoff = dosView.getUint32(0x3c, true);
    // Go ignores the error from this ReadAt, leaving the signature zeroed,
    // which then fails the comparison below with an all-zero rendering.
    const sign = [0, 0, 0, 0];
    if (signoff + 4 <= raw.length) {
      for (let i = 0; i < 4; i++) sign[i] = raw[signoff + i];
    }
    if (!(sign[0] === 0x50 && sign[1] === 0x45 && sign[2] === 0 && sign[3] === 0)) {
      throw new PEError(
        `invalid PE file signature: ${sign.map((b) => hex2(b).toLowerCase()).join(' ')}`,
      );
    }
    base = signoff + 4;
  }

  cur.seek(base);
  // binary.Read fills the whole 20-byte FileHeader in one io.ReadFull, so a
  // partial header is "unexpected EOF", never the "EOF" of a per-field read.
  cur.need(FILE_HEADER_SIZE);
  const fh = {
    machine: cur.u16(),
    numberOfSections: cur.u16(),
    timeDateStamp: cur.u32(),
    pointerToSymbolTable: cur.u32(),
    numberOfSymbols: cur.u32(),
    sizeOfOptionalHeader: cur.u16(),
    characteristics: cur.u16(),
  };

  if (!ALLOWED_MACHINES.has(fh.machine)) {
    throw new PEError(`unrecognized PE machine: 0x${fh.machine.toString(16)}`);
  }

  const stringTable = readStringTable(fh, cur);
  const coffSymbols = readCOFFSymbols(fh, cur);
  removeAuxSymbols(coffSymbols, stringTable);

  cur.seek(base + FILE_HEADER_SIZE);
  const optionalHeader = readOptionalHeader(cur, fh.sizeOfOptionalHeader);

  const sections = [];
  for (let i = 0; i < fh.numberOfSections; i++) {
    cur.need(SECTION_HEADER_SIZE);
    const nameBytes = cur.bytes(8);
    const virtualSize = cur.u32();
    const virtualAddress = cur.u32();
    const size = cur.u32();
    const offset = cur.u32();
    const pointerToRelocations = cur.u32();
    const pointerToLineNumbers = cur.u32();
    const numberOfRelocations = cur.u16();
    const numberOfLineNumbers = cur.u16();
    const characteristics = cur.u32();
    sections.push({
      name: sectionFullName(nameBytes, stringTable),
      virtualSize,
      virtualAddress,
      size,
      offset,
      pointerToRelocations,
      pointerToLineNumbers,
      numberOfRelocations,
      numberOfLineNumbers,
      characteristics,
    });
  }

  // Go runs a second pass reading every section's relocation table, and its
  // errors reject the file. Omitting it made newFile accept PEs that Go rejects
  // — which matters because newFile is the validity gate for restoreFromBackup.
  for (const s of sections) {
    readRelocs(s, cur);
  }

  return { fileHeader: fh, optionalHeader, sections, stringTable, raw };
}

const RELOC_SIZE = 10;

function readRelocs(sh, cur) {
  if (sh.numberOfRelocations <= 0) return [];
  cur.seek(sh.pointerToRelocations);
  const relocs = [];
  try {
    cur.need(sh.numberOfRelocations * RELOC_SIZE);
    for (let i = 0; i < sh.numberOfRelocations; i++) {
      const virtualAddress = cur.u32();
      const symbolTableIndex = cur.u32();
      const type = cur.u16();
      relocs.push({ virtualAddress, symbolTableIndex, type });
    }
  } catch (e) {
    throw new PEError(`fail to read section relocations: ${e.message}`);
  }
  return relocs;
}

// sectionData mirrors Section.Data(). saferio makes this all-or-nothing: a
// section whose raw range runs past EOF yields null, NOT a truncated buffer.
// pe.go relies on this — `d, _ := pd.Data()` then yields no .pdata entries.
export function sectionData(file, section) {
  if (section.offset === 0) return null;
  const end = section.offset + section.size;
  if (end > file.raw.length) return null;
  return file.raw.subarray(section.offset, end);
}
