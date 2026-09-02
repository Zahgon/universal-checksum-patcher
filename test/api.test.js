// Coverage the Go suite does not have: backup/restore/atomic-write, the
// preserved upstream panic, and the JavaScript-specific hazards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openImage } from '../src/core/image.js';
import { loadConfig } from '../src/core/config.js';
import { applySite, patchImage, StatusPatched } from '../src/core/patch.js';
import {
  backupIfAbsent, restoreFromBackup, writePatched, writeFileAtomic, ErrChangedOnDisk,
} from '../src/core/backup.js';
import { isPermission, isNotExist } from '../src/internal/goerrors.js';
import { CoreError } from '../src/core/pattern.js';
import { buildFixture } from '../verification/make-fixture.mjs';
import { gateSite, synthImage } from './helpers.js';

const CORPUS = fileURLToPath(new URL('../verification/corpus/toolkit.exe', import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), 'ucp-api-'));
}

test('D1 an empty anchor reproduces Go\'s slice-bounds panic', () => {
  const img = openImage(CORPUS);
  assert.throws(() => img.stringVAs(''), (err) => {
    assert.ok(err instanceof RangeError);
    assert.equal(err.message, 'runtime error: slice bounds out of range [846849:846848]');
    return true;
  });
});

test('D1 is reachable through funcsReferencingString, as in Go', () => {
  const img = openImage(CORPUS);
  assert.throws(() => img.funcsReferencingString(''), RangeError);
});

test('backupIfAbsent creates once and never overwrites a good backup', () => {
  const dir = tmp();
  const exe = join(dir, 'eu4.exe');
  copyFileSync(CORPUS, exe);
  const pristine = new Uint8Array(readFileSync(exe));

  const first = backupIfAbsent(exe, pristine);
  assert.equal(first.created, true);
  assert.equal(first.staleWarning, false);
  assert.ok(existsSync(`${exe}.backup`));

  const second = backupIfAbsent(exe, pristine);
  assert.equal(second.created, false);
  assert.equal(second.staleWarning, false);
});

test('backupIfAbsent flags a stale pre-existing backup', () => {
  const dir = tmp();
  const exe = join(dir, 'eu4.exe');
  copyFileSync(CORPUS, exe);
  writeFileSync(`${exe}.backup`, 'a different build');
  const { created, staleWarning } = backupIfAbsent(exe, new Uint8Array(readFileSync(exe)));
  assert.equal(created, false);
  assert.equal(staleWarning, true);
});

test('restoreFromBackup refuses a backup that is not a valid PE', () => {
  const dir = tmp();
  const exe = join(dir, 'eu4.exe');
  copyFileSync(CORPUS, exe);
  writeFileSync(`${exe}.backup`, 'not an executable at all'.repeat(10));
  assert.throws(() => restoreFromBackup(exe), (err) => {
    assert.equal(
      err.message,
      'backup eu4.exe.backup is not a valid executable — refusing to restore',
    );
    return true;
  });
  // The target must be untouched by the refusal.
  assert.equal(readFileSync(exe).length, readFileSync(CORPUS).length);
});

test('restoreFromBackup reports a missing backup by base name', () => {
  const dir = tmp();
  const exe = join(dir, 'eu4.exe');
  copyFileSync(CORPUS, exe);
  assert.throws(() => restoreFromBackup(exe), (err) => {
    assert.equal(err.message, 'no backup found (eu4.exe.backup)');
    return true;
  });
});

test('writePatched aborts when the file changed on disk', () => {
  const dir = tmp();
  const exe = join(dir, 'eu4.exe');
  writeFileSync(exe, 'original contents');
  const stale = new Uint8Array(Buffer.from('something else'));
  assert.throws(
    () => writePatched(exe, stale, new Uint8Array(Buffer.from('patched'))),
    (err) => {
      assert.equal(err, ErrChangedOnDisk);
      return true;
    },
  );
  assert.equal(readFileSync(exe, 'utf8'), 'original contents');
});

test('writeFileAtomic leaves no temp file behind', () => {
  const dir = tmp();
  const target = join(dir, 'out.bin');
  writeFileAtomic(target, new Uint8Array([1, 2, 3]));
  assert.deepEqual(Array.from(readFileSync(target)), [1, 2, 3]);
  assert.deepEqual(readdirSync(dir), ['out.bin']);
});

test('full patch / restore round-trip on a real PE is byte-exact', () => {
  const dir = tmp();
  const exe = join(dir, 'eu4.exe');
  buildFixture(CORPUS, exe);
  const original = readFileSync(exe);

  const { cfg } = loadConfig('');
  const img = openImage(exe);
  const { patched, changed } = patchImage(img, cfg.games['eu4.exe']);
  assert.equal(changed, true);

  backupIfAbsent(exe, img.raw);
  writePatched(exe, img.raw, patched);
  assert.notDeepEqual(readFileSync(exe), original);

  // Re-running is a no-op: the gate is already patched.
  const img2 = openImage(exe);
  const again = patchImage(img2, cfg.games['eu4.exe']);
  assert.equal(again.changed, false);

  restoreFromBackup(exe);
  assert.deepEqual(readFileSync(exe), original);
});

test('config maps use a null prototype so game names cannot pollute', () => {
  const dir = tmp();
  const p = join(dir, 'sig.json');
  writeFileSync(p, JSON.stringify({ games: { __proto__: { sites: [] }, polluted: { sites: [] } } }));
  const { cfg } = loadConfig(p);
  assert.equal(Object.getPrototypeOf(cfg.games), null);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('a missing override falls back to the embedded signatures', () => {
  const { cfg, src } = loadConfig('definitely-does-not-exist.json');
  assert.equal(src, 'embedded');
  assert.ok(cfg.games['hoi4.exe'] !== undefined);
});

test('applySite writing through img.raw aliases the .text view, as Go slices do', () => {
  const img = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8]);
  const view = img.bytes(img.text());
  assert.equal(view[1], 0x85);
  const r = applySite(img, img.raw, gateSite());
  assert.equal(r.status, StatusPatched);
  // The view must observe the write without being refetched.
  assert.equal(view[1], 0x31);
});

test('patchImage writes into a clone, leaving img.raw pristine', () => {
  const img = synthImage([0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8]);
  const { patched, changed } = patchImage(img, { sites: [gateSite()] });
  assert.equal(changed, true);
  assert.equal(img.raw[0x201], 0x85);
  assert.equal(patched[0x201], 0x31);
});

test('config rejects wrong types exactly as json.Unmarshal does', () => {
  const dir = tmp();
  const write = (name, obj) => {
    const p = join(dir, `${name}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  // A quoted patchOffset would otherwise reach `rva + site.patchOffset`, where
  // + concatenates and the patch lands at a completely different address.
  assert.throws(
    () => loadConfig(write('a', {
      games: { 'eu4.exe': { sites: [{ id: 'g', find: '85 C0', patchOffset: '0', expect: '85', replace: '31' }] } },
    })),
    (err) => {
      assert.equal(
        err.message,
        'json: cannot unmarshal string into Go struct field Site.games.sites.patchOffset of type int',
      );
      return true;
    },
  );

  assert.throws(() => loadConfig(write('b', { games: { 'eu4.exe': { sites: [{ expectMatches: 2.5 }] } } })),
    /cannot unmarshal number 2\.5 .* of type int/);
  assert.throws(() => loadConfig(write('c', { games: { 'eu4.exe': { sites: [{ requireInFunc: 'true' }] } } })),
    /cannot unmarshal string .* of type bool/);
  assert.throws(() => loadConfig(write('d', { games: { 'eu4.exe': { sites: 'nope' } } })),
    /cannot unmarshal string .* of type \[\]core\.Site/);
  assert.throws(() => loadConfig(write('e', { games: [] })),
    /cannot unmarshal array .* of type map\[string\]core\.Game/);
  assert.throws(() => loadConfig(write('f', 5)),
    /cannot unmarshal number into Go value of type core\.Config/);
});

test('config accepts what json.Unmarshal accepts', () => {
  const dir = tmp();
  const write = (name, obj) => {
    const p = join(dir, `${name}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  // json.Unmarshal falls back to a case-insensitive field match.
  const ci = loadConfig(write('ci', { Games: { 'eu4.exe': { Sites: [{ ID: 'g', PatchOffset: 3 }] } } }));
  assert.equal(ci.cfg.games['eu4.exe'].sites[0].patchOffset, 3);
  assert.equal(ci.cfg.games['eu4.exe'].sites[0].id, 'g');

  const nulls = loadConfig(write('n', { games: { 'eu4.exe': { sites: null } } }));
  assert.deepEqual(nulls.cfg.games['eu4.exe'].sites, []);

  const empty = loadConfig(write('m', { games: { 'eu4.exe': { sites: [{}] } } }));
  assert.equal(empty.cfg.games['eu4.exe'].sites[0].patchOffset, 0);
  assert.equal(empty.cfg.games['eu4.exe'].sites[0].requireInFunc, false);
});

test('writeFileAtomic surfaces a short write instead of truncating', () => {
  // fs.writeSync reports a short write only through its return value; an
  // unchecked call would rename a truncated file over the target executable.
  const dir = tmp();
  const target = join(dir, 'exe.bin');
  writeFileSync(target, 'original');
  const src = readFileSync(new URL('../src/core/backup.js', import.meta.url), 'utf8');
  assert.match(src, /const written = writeSync\(/);
  assert.match(src, /if \(written !== data\.length\) throw new CoreError\('short write'\)/);
  // The normal path still writes in full.
  writeFileAtomic(target, new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(Array.from(readFileSync(target)), [1, 2, 3, 4]);
});

test('isPermission recognises the errors Go maps to os.ErrPermission', () => {
  // permErr() in bin/patcher.js turns this into the "Run as administrator"
  // hint, so it is the difference between an actionable message and a raw errno.
  assert.equal(isPermission({ code: 'EACCES' }), true);
  assert.equal(isPermission({ code: 'EPERM' }), true);
  assert.equal(isPermission({ code: 'ENOENT' }), false);
  assert.equal(isPermission(null), false);
  assert.equal(isPermission(undefined), false);
  // errors.Is unwraps; so must this.
  assert.equal(isPermission(new CoreError('write backup', { code: 'EACCES' })), true);
  assert.equal(isPermission(new CoreError('write backup', { code: 'ENOSPC' })), false);
});

test('isNotExist matches os.IsNotExist', () => {
  assert.equal(isNotExist({ code: 'ENOENT' }), true);
  assert.equal(isNotExist({ code: 'EACCES' }), false);
  assert.equal(isNotExist(new CoreError('read override', { code: 'ENOENT' })), true);
});
