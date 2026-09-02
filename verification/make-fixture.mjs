// Builds an `eu4.exe` fixture by injecting the eu4 checksum-gate byte sequence
// into two .pdata-covered spots in a real PE's .text. The eu4 recipe has no
// string anchor and expects exactly 2 matches, so this exercises the full
// patch / backup / restore path against a genuine PE.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openImage } from '../src/core/image.js';
import { parsePattern, findAll } from '../src/core/pattern.js';

const GATE = Uint8Array.from([0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8]);

export function buildFixture(sourcePath, destPath) {
  const img = openImage(sourcePath);
  const text = img.text();
  const raw = img.raw.slice();

  const spots = [];
  for (const fr of img.pdata) {
    if (fr.end - fr.begin < 64) continue;
    const rva = fr.begin + 16;
    const { off, ok } = img.rvaToFileOff(rva);
    if (!ok) continue;
    if (off + GATE.length > raw.length) continue;
    spots.push({ rva, off });
    if (spots.length === 2) break;
  }
  if (spots.length !== 2) throw new Error('could not find two injection spots');

  for (const s of spots) raw.set(GATE, s.off);
  writeFileSync(destPath, raw);

  const check = openImage(destPath);
  const hits = findAll(parsePattern('85 C0 0F 94 C3 E8'), check.bytes(check.text()));
  if (hits.length !== 2) {
    throw new Error(`fixture has ${hits.length} gate matches, want exactly 2`);
  }
  return { spots, textRVA: text.rva };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = fileURLToPath(new URL('./corpus/toolkit.exe', import.meta.url));
  const dest = process.argv[2];
  console.log(JSON.stringify(buildFixture(src, dest)));
}
