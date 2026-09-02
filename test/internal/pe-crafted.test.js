// Replays hand-built PEs that sit exactly on debug/pe's structural boundaries,
// against the outcome recorded from a real Go run. These fixtures are committed
// so the PE parser's fidelity is checked by `npm test` alone, without needing a
// Go toolchain; verification/fuzz-diff.mjs covers the same ground plus 115
// mutated binaries when Go is available.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { openImage } from '../../src/core/image.js';

const DIR = fileURLToPath(new URL('../fixtures/pe/', import.meta.url));
const expected = JSON.parse(readFileSync(join(DIR, 'go-expected.json'), 'utf8'));

for (const [name, want] of Object.entries(expected)) {
  test(`crafted PE matches Go: ${name}`, () => {
    const path = join(DIR, name);
    let got;
    try {
      const img = openImage(path);
      got = {
        err: '', panic: '',
        base: img.base, ptrSize: img.ptrSize,
        nSec: img.sections.length, nPdata: img.pdata.length,
      };
    } catch (err) {
      const isPanic = err instanceof RangeError;
      got = {
        err: isPanic ? '' : err.message.split(path).join('<F>'),
        panic: isPanic ? err.message : '',
        base: 0, ptrSize: 0, nSec: 0, nPdata: 0,
      };
    }
    assert.deepEqual(got, want);
  });
}
