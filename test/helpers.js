import { Image } from '../src/core/image.js';

const TEXT_RVA = 0x1000;
const TEXT_FILEOFF = 0x200;

// synthImage builds a minimal in-memory x64 image with a single .text section
// and one .pdata function spanning it, so applySite can be exercised without a
// real PE. Mirrors synthImage in core_test.go.
export function synthImage(text) {
  const bytes = Uint8Array.from(text);
  const raw = new Uint8Array(TEXT_FILEOFF + bytes.length + 16);
  raw.set(bytes, TEXT_FILEOFF);
  return new Image({
    path: '',
    raw,
    base: 0x140000000,
    ptrSize: 8,
    machine: 0x8664,
    sections: [{
      name: '.text',
      rva: TEXT_RVA,
      vSize: bytes.length,
      fileOff: TEXT_FILEOFF,
      rawSize: bytes.length,
    }],
    pdata: [{ begin: TEXT_RVA, end: TEXT_RVA + bytes.length }],
  });
}

export function gateSite() {
  return {
    id: 'g',
    anchor: '',
    find: '85 C0 0F 94 ?? E8',
    patchOffset: 0,
    expect: '85 C0',
    replace: '31 C0',
    requireInFunc: true,
    expectMatches: 1,
    note: '',
  };
}

export { TEXT_RVA, TEXT_FILEOFF };
