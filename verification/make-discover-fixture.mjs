// Builds a PE that actually trips the toolkit's `discover` path: a .pdata
// function that both references a gate keyword string and contains the
// test;setcc gate shape. Without this, score / pickAnchor / suggestRecipe /
// isMD5 are never executed by any test, because the stock corpus yields zero
// keyword-matching candidates.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openImage } from '../src/core/image.js';
import { stringsInFunc } from '../src/core/discover.js';

const GATE = Uint8Array.from([0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8]);
const ANCHOR = 'Active Mod Count: ';
const MD5 = '0123456789abcdef0123456789abcdef';

// Locates the file offset of a NUL-terminated string by value, so it can be
// overwritten in place without disturbing any surrounding layout.
function findStringOffset(img, value) {
  const needle = new TextEncoder().encode(value);
  for (const sec of img.sections) {
    const data = img.bytes(sec);
    if (data === null) continue;
    outer: for (let i = 0; i + needle.length <= data.length; i++) {
      for (let k = 0; k < needle.length; k++) {
        if (data[i + k] !== needle[k]) continue outer;
      }
      // Go packs string data without NUL terminators, so the donor is found by
      // value alone; cStringAt stops at whichever NUL is written here.
      return sec.fileOff + i;
    }
  }
  return -1;
}

export function buildDiscoverFixture(sourcePath, destPath) {
  const img = openImage(sourcePath);
  const text = img.text();
  const raw = img.raw.slice();

  for (const fr of img.pdata) {
    if (fr.end - fr.begin < 128) continue;
    const strs = stringsInFunc(img, fr);
    // Two donor strings: one becomes the anchor, one becomes an MD5 hash, so
    // score() exercises both its keyword table and its isMD5 bonus.
    const donorA = strs.find((s) => s.length >= ANCHOR.length + 1);
    const donorB = strs.find((s) => s !== donorA && s.length >= MD5.length + 1);
    if (donorA === undefined || donorB === undefined) continue;

    const offA = findStringOffset(img, donorA);
    const offB = findStringOffset(img, donorB);
    if (offA < 0 || offB < 0) continue;

    const gateRVA = fr.begin + 32;
    const { off: gateOff, ok } = img.rvaToFileOff(gateRVA);
    if (!ok || gateOff + GATE.length > raw.length) continue;

    // stringVAs only accepts a match that begins at a string boundary, so the
    // preceding byte must be NUL for the anchored search path to find this.
    if (offA > 0) raw[offA - 1] = 0;
    raw.set(new TextEncoder().encode(ANCHOR), offA);
    raw[offA + ANCHOR.length] = 0;
    raw.set(new TextEncoder().encode(MD5), offB);
    raw[offB + MD5.length] = 0;
    raw.set(GATE, gateOff);

    writeFileSync(destPath, raw);
    return { func: fr, gateRVA, anchor: ANCHOR, donorA, donorB, textRVA: text.rva };
  }
  throw new Error('no suitable donor function found');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = fileURLToPath(new URL('./corpus/toolkit.exe', import.meta.url));
  console.log(JSON.stringify(buildDiscoverFixture(src, process.argv[2]), null, 1));
}
