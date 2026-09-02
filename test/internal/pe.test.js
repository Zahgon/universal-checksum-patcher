// Pins the debug/pe behaviours that OpenImage exposes, against the real PE in
// verification/corpus. All expectations are recorded Go values.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openImage } from '../../src/core/image.js';
import { newFile, sectionData, PEError } from '../../src/internal/gope.js';
import { CoreError } from '../../src/core/pattern.js';

const CORPUS = fileURLToPath(new URL('../../verification/corpus/toolkit.exe', import.meta.url));

test('parses the real PE header exactly as debug/pe does', () => {
  const img = openImage(CORPUS);
  assert.equal(img.base, 0x140000000);
  assert.equal(img.ptrSize, 8);
  assert.equal(img.machine, 0x8664);
  assert.equal(img.isX64(), true);
  assert.equal(img.sections.length, 16);
  assert.equal(img.pdata.length, 1939);
});

test('resolves long section names through the COFF string table', () => {
  const img = openImage(CORPUS);
  const names = img.sections.map((s) => s.name);
  // These exceed the 8-byte inline field, so debug/pe reads them from the
  // string table via the `/NNN` form.
  assert.ok(names.includes('.zdebug_abbrev'));
  assert.ok(names.includes('.debug_gdb_scripts'));
  assert.ok(names.includes('.zdebug_loclists'));
  assert.ok(names.includes('.text'));
});

test('.text section geometry matches Go', () => {
  const img = openImage(CORPUS);
  const text = img.text();
  assert.equal(text.rva, 0x1000);
  assert.equal(text.vSize, 0xcea51);
  assert.equal(text.fileOff, 0x600);
  assert.equal(text.rawSize, 0xcec00);
  assert.equal(img.bytes(text).length, 846848);
});

test('funcContains mirrors sort.Search at range edges', () => {
  const img = openImage(CORPUS);
  const fr = img.pdata[10];
  assert.equal(img.funcContains(fr.begin).in, true);
  assert.equal(img.funcContains(fr.end - 1).in, true);
  // End is exclusive.
  const atEnd = img.funcContains(fr.end);
  if (atEnd.in) assert.notEqual(atEnd.fr.begin, fr.begin);
  assert.equal(img.funcContains(0).in, false);
  assert.equal(img.funcContains(0xffffffff).in, false);
});

test('rvaToFileOff rejects RVAs outside a raw-backed section', () => {
  const img = openImage(CORPUS);
  assert.equal(img.rvaToFileOff(0).ok, false);
  assert.equal(img.rvaToFileOff(0xffffffff).ok, false);
  assert.equal(img.rvaToFileOff(0x1000).ok, true);
  assert.equal(img.rvaToFileOff(0x1000).off, 0x600);
});

test('openImage error text matches Go PathError rendering', () => {
  assert.throws(() => openImage('does-not-exist.exe'), (err) => {
    assert.equal(
      err.message,
      'read does-not-exist.exe: open does-not-exist.exe: no such file or directory',
    );
    return true;
  });
  // EISDIR carries no path in Node; it must be back-filled to match Go.
  assert.throws(() => openImage('.'), (err) => {
    assert.equal(err.message, 'read .: read .: is a directory');
    return true;
  });
});

test('a non-PE file is rejected with Go machine-check text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucp-pe-'));
  const p = join(dir, 'notpe.json');
  writeFileSync(p, '{\n  "games": {}\n}'.padEnd(200, ' '));
  assert.throws(() => openImage(p), (err) => {
    assert.ok(err instanceof CoreError);
    assert.equal(err.message, `parse PE ${p}: unrecognized PE machine: 0xa7b`);
    return true;
  });
});

test('a file shorter than the DOS header is EOF, as bytes.Reader reports', () => {
  assert.throws(() => newFile(new Uint8Array(10)), (err) => {
    assert.ok(err instanceof PEError);
    assert.equal(err.message, 'EOF');
    return true;
  });
});

test('sectionData is all-or-nothing on truncation, like saferio', () => {
  const img = openImage(CORPUS);
  const file = { raw: img.raw, sections: [] };
  const truncated = { offset: img.raw.length - 8, size: 4096 };
  assert.equal(sectionData(file, truncated), null);
  const fits = { offset: 0x600, size: 16 };
  assert.equal(sectionData(file, fits).length, 16);
  // Offset 0 selects Go's nobits reader, which always fails, so Data() is nil
  // regardless of the requested size.
  assert.equal(sectionData(file, { offset: 0, size: 16 }), null);
  assert.equal(sectionData(file, { offset: 0, size: 0 }), null);
});

test('img.bytes clamps where sectionData refuses', () => {
  const img = openImage(CORPUS);
  // Bytes() clamps to EOF rather than returning nil; the two Go functions
  // genuinely differ and both behaviours are relied upon.
  const overrun = { fileOff: img.raw.length - 8, rawSize: 4096 };
  assert.equal(img.bytes(overrun).length, 8);
  assert.equal(img.bytes({ fileOff: img.raw.length + 1, rawSize: 4 }), null);
});
