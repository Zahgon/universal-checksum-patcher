// 1:1 port of internal/core/core_test.go. Names and assertions are preserved so
// the pass count can be compared directly against the Go baseline.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePattern, parseBytes, findAll, overlay } from '../src/core/pattern.js';
import { loadConfig } from '../src/core/config.js';
import {
  applySite, patchImage, bytesEqual,
  StatusPatched, StatusAlready, StatusNoMatch, StatusAmbig, StatusError,
} from '../src/core/patch.js';
import { gateSite, synthImage, TEXT_FILEOFF } from './helpers.js';

test('TestParsePattern', () => {
  const p = parsePattern('85 C0 ?? 0F');
  const want = [0x85, 0xc0, -1, 0x0f];
  assert.equal(p.length, want.length, `len ${p.length} != ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    assert.equal(p[i], want[i], `byte ${i}: ${p[i]} != ${want[i]}`);
  }
  assert.throws(() => parsePattern('85 ZZ'), 'expected error on bad token');
  assert.throws(() => parsePattern(''), 'expected error on empty pattern');
});

test('TestFindAllWildcards', () => {
  const data = Uint8Array.from([0x00, 0x85, 0xc0, 0x11, 0x0f, 0x85, 0xc0, 0x22, 0x0f, 0x90]);
  const p = parsePattern('85 C0 ?? 0F');
  const got = findAll(p, data);
  assert.ok(
    got.length === 2 && got[0] === 1 && got[1] === 5,
    `FindAll = ${JSON.stringify(got)}, want [1 5]`,
  );
});

test('TestOverlay', () => {
  const p = parsePattern('85 C0 0F 94 ?? E8');
  const q = overlay(p, 0, Uint8Array.from([0x31, 0xc0]));
  assert.ok(
    q[0] === 0x31 && q[1] === 0xc0 && q[4] === -1,
    `overlay wrong: ${JSON.stringify(q)}`,
  );
  assert.equal(p[0], 0x85, 'Overlay mutated original pattern');
});

test('TestLoadConfigEmbedded', () => {
  const { cfg, src } = loadConfig('');
  assert.equal(src, 'embedded', `src = ${JSON.stringify(src)}`);
  for (const name of ['hoi4.exe', 'eu4.exe', 'eu5.exe']) {
    const g = cfg.games[name];
    assert.ok(g !== undefined && g.sites.length > 0, `game ${name} missing or has no sites`);
    for (const s of g.sites) {
      assert.doesNotThrow(() => parsePattern(s.find), `${name}/${s.id}: bad find pattern`);
      assert.doesNotThrow(() => parseBytes(s.expect), `${name}/${s.id}: bad expect`);
      assert.doesNotThrow(() => parseBytes(s.replace), `${name}/${s.id}: bad replace`);
    }
  }
});

test('TestApplySitePatchAndIdempotent', () => {
  const img = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x11, 0x22, 0x33]);
  const r = applySite(img, img.raw, gateSite());
  assert.ok(
    r.status === StatusPatched && r.rvas.length === 1,
    `status ${r.status} rvas ${JSON.stringify(r.rvas)}`,
  );
  assert.ok(
    img.raw[TEXT_FILEOFF + 1] === 0x31 && img.raw[TEXT_FILEOFF + 2] === 0xc0,
    `bytes not patched: ${img.raw[0x201]} ${img.raw[0x202]}`,
  );
  const r2 = applySite(img, img.raw, gateSite());
  assert.equal(r2.status, StatusAlready, `re-run status = ${r2.status}, want already-patched`);
});

test('TestApplySiteNotFound', () => {
  const img = synthImage([0x90, 0x90, 0x90, 0x90]);
  const r = applySite(img, img.raw, gateSite());
  assert.equal(r.status, StatusNoMatch, `status = ${r.status}, want not-found`);
});

test('TestApplySiteAmbiguousRefuses', () => {
  const img = synthImage([
    0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x00,
    0x85, 0xc0, 0x0f, 0x94, 0xc1, 0xe8, 0x00,
  ]);
  const before = img.raw.slice();
  const s = gateSite();
  s.expectMatches = 1;
  const r = applySite(img, img.raw, s);
  assert.equal(r.status, StatusAmbig, `status = ${r.status}, want ambiguous`);
  assert.ok(bytesEqual(img.raw, before), 'ambiguous match must not modify the image');
});

test('TestApplySiteExpectMismatch', () => {
  const img = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8]);
  const s = gateSite();
  s.expect = '99 99';
  const r = applySite(img, img.raw, s);
  assert.equal(r.status, StatusError, `status = ${r.status}, want error`);
});

test('TestPatchImageTransactionalDiscardsOnBlock', () => {
  const img2 = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x90]);
  const good = gateSite();
  const bad = {
    id: 'bad', anchor: '', find: '90', patchOffset: 0, expect: '90',
    replace: 'CC', requireInFunc: false, expectMatches: 1, note: '',
  };
  const { results, patched, changed } = patchImage(img2, { sites: [good, bad] });
  assert.ok(
    !changed && patched === null,
    `expected transactional discard: changed=${changed} patchedNil=${patched === null}`,
  );
  const sawAmbig = results.some((r) => r.status === StatusAmbig);
  assert.ok(sawAmbig, 'expected an ambiguous site');
  assert.equal(img2.raw[TEXT_FILEOFF + 1], 0x85, 'PatchImage mutated img.Raw despite blocking');
});

test('TestPatchImageBlocksOnNotFound', () => {
  const img = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x11]);
  const good = gateSite();
  const missing = {
    id: 'missing', anchor: '', find: 'DE AD BE EF', patchOffset: 0, expect: 'DE',
    replace: 'FF', requireInFunc: false, expectMatches: 1, note: '',
  };
  const { patched, changed } = patchImage(img, { sites: [good, missing] });
  assert.ok(
    !changed && patched === null,
    `expected discard on not-found site: changed=${changed} patchedNil=${patched === null}`,
  );
  assert.equal(img.raw[0x201], 0x85, 'img.Raw mutated despite a blocking not-found site');
});

test('TestApplySiteRequireInFuncFiltersOutOfFunc', () => {
  const img = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8]);
  img.pdata = [];
  const r = applySite(img, img.raw, gateSite());
  assert.equal(r.status, StatusNoMatch, `status = ${r.status}, want not-found (filtered)`);
});
