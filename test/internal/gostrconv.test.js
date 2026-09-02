// Pins the Go semantics that JavaScript does not provide by default. Every
// expectation is a value recorded from a real Go run (see verification/).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fields, isPrint, isSpaceUnicode, parseUint, quote, hex2, hexUpper, atoi,
  bytesToGoString,
} from '../../src/internal/gostrconv.js';

test('G1 strings.Fields splits on unicode.IsSpace, not JavaScript \\s', () => {
  assert.deepEqual(fields('85 C0 ?? 0F'), ['85', 'C0', '??', '0F']);
  assert.deepEqual(fields('  85\tC0\n?? 0F '), ['85', 'C0', '??', '0F']);
  assert.deepEqual(fields(''), []);
  assert.deepEqual(fields('   '), []);
  // NBSP and U+3000 are unicode.IsSpace, so they do separate tokens.
  assert.deepEqual(fields('\u00a0'), []);
  assert.deepEqual(fields('85\u3000C0'), ['85', 'C0']);
  assert.deepEqual(fields('85\u000bC0'), ['85', 'C0']);
  // U+FEFF is JavaScript \s but NOT Go's unicode.IsSpace: one token, not two.
  assert.deepEqual(fields('85\ufeffC0'), ['85\ufeffC0']);
  assert.equal(isSpaceUnicode(0xfeff), false);
  assert.equal(isSpaceUnicode(0x00a0), true);
  assert.equal(isSpaceUnicode(0x3000), true);
});

test('G2 strconv.ParseUint is strict where parseInt is not', () => {
  assert.equal(parseUint('FF', 16, 8), 255);
  assert.equal(parseUint('ff', 16, 8), 255);
  assert.equal(parseUint('Ff', 16, 8), 255);
  assert.equal(parseUint('0', 16, 8), 0);
  assert.equal(parseUint('000', 16, 8), 0);
  assert.equal(parseUint('8', 16, 8), 8);

  // parseInt would accept every one of these.
  for (const bad of ['0x85', '0X85', '-1', '+1', '-0', 'ZZ', 'GG', '1G', '??C0', '']) {
    assert.throws(() => parseUint(bad, 16, 8), /invalid syntax/, `expected syntax error for ${bad}`);
  }
  // Range, not syntax — and reported immediately on overflow.
  assert.throws(() => parseUint('100', 16, 8), /value out of range/);
  assert.throws(() => parseUint('1000G', 16, 8), /value out of range/);

  assert.equal(parseUint('FFFFFFFF', 16, 64), 0xffffffff);
  // A byte >= 0x80 is a syntax error because Go iterates s as bytes.
  assert.throws(() => parseUint('é', 16, 8), /invalid syntax/);
});

test('G2 ParseUint error text matches Go exactly', () => {
  assert.throws(() => parseUint('ZZ', 16, 8), (err) => {
    assert.equal(err.message, 'strconv.ParseUint: parsing "ZZ": invalid syntax');
    return true;
  });
  assert.throws(() => parseUint('100', 16, 8), (err) => {
    assert.equal(err.message, 'strconv.ParseUint: parsing "100": value out of range');
    return true;
  });
});

test('G3 %q is strconv.Quote, not JSON.stringify', () => {
  assert.equal(quote('abc'), '"abc"');
  assert.equal(quote('a"b'), '"a\\"b"');
  assert.equal(quote('a\\b'), '"a\\\\b"');
  // Go writes \x00; JSON.stringify writes \u0000.
  assert.equal(quote('\u0000'), '"\\x00"');
  assert.notEqual(quote('\u0000'), JSON.stringify('\u0000'));
  assert.equal(quote('\n'), '"\\n"');
  assert.equal(quote('\t'), '"\\t"');
  assert.equal(quote('\u0007'), '"\\a"');
  assert.equal(quote('\u000b'), '"\\v"');
  // NBSP is not printable in Go, so it is escaped; JSON leaves it literal.
  assert.equal(quote('\u00a0'), '"\\u00a0"');
  assert.equal(quote('\u2028'), '"\\u2028"');
  // A printable non-ASCII rune stays literal.
  assert.equal(quote('©'), '"©"');
  assert.equal(quote('日本'), '"日本"');
  // Astral plane uses \U with 8 digits when non-printable, literal otherwise.
  assert.equal(quote('😀'), '"😀"');
});

test('G3 unicode.IsPrint matches Go for the Latin-1 special cases', () => {
  assert.equal(isPrint(0x20), true);
  assert.equal(isPrint(0x7e), true);
  assert.equal(isPrint(0x7f), false);
  assert.equal(isPrint(0xa0), false);
  assert.equal(isPrint(0xad), false);
  assert.equal(isPrint(0xa9), true);
  assert.equal(isPrint(0xff), true);
});

test('%02X and %X verbs', () => {
  assert.equal(hex2(0), '00');
  assert.equal(hex2(0x0f), '0F');
  assert.equal(hex2(0xff), 'FF');
  assert.equal(hexUpper(0x140000000), '140000000');
  assert.equal(hexUpper(0x1000), '1000');
});

test('strconv.Atoi for COFF /NNN section names', () => {
  assert.equal(atoi('4'), 4);
  assert.equal(atoi('123'), 123);
  assert.throws(() => atoi('12a'), /invalid syntax/);
  assert.throws(() => atoi(''), /invalid syntax/);
});

test('G3 regression: DEL takes the \\x form, not \\u', () => {
  // Go's predicate is `r < ' ' || r == 0x7f`. Omitting the 0x7f arm produced
  // "\u007f" where Go writes "\x7f" — reachable from a CLI pattern argument.
  assert.equal(quote('\u007f'), '"\\x7f"');
  assert.equal(quote('a\u007fb'), '"a\\x7fb"');
  assert.equal(quote('\u001f'), '"\\x1f"');
  assert.equal(quote('\u0080'), '"\\u0080"');
});

test('atoi is int-ranged and rejects overflow like Go', () => {
  assert.equal(atoi('-5'), -5);
  assert.throws(() => atoi('99999999999999999999'), /value out of range/);
});

test('G3 regression: %q renders invalid UTF-8 bytes as \\xNN, not as latin1 text', () => {
  // A Go string holds raw bytes. Decoding them as latin1 turns 0xE8 into a
  // printable 'e-grave', which quote() then prints literally where Go prints
  // \xe8. Every expectation here is recorded from a real Go run.
  const q = (bytes) => quote(bytesToGoString(Uint8Array.from(bytes)));

  assert.equal(q([0xe8, 0x12, 0xfe, 0xff, 0xff, 0x84, 0xc0]), '"\\xe8\\x12\\xfe\\xff\\xff\\x84\\xc0"');
  assert.equal(q([0x84]), '"\\x84"');
  assert.equal(q([0xe8]), '"\\xe8"');
  assert.equal(q([0xff]), '"\\xff"');
  // Valid multi-byte sequences still decode to their rune and stay literal.
  assert.equal(q([0xc3, 0xa9]), '"é"');
  assert.equal(q([0xe6, 0x97, 0xa5]), '"日"');
  assert.equal(q([0xf0, 0x9f, 0x98, 0x80]), '"😀"');
  assert.equal(q([0x2e, 0x74, 0x65, 0x78, 0x74]), '".text"');
  // Overlong and surrogate encodings are invalid in Go and escape per byte.
  assert.equal(q([0xc0, 0xaf]), '"\\xc0\\xaf"');
  assert.equal(q([0xed, 0xa0, 0x80]), '"\\xed\\xa0\\x80"');
  // A truncated sequence escapes the bytes that are present.
  assert.equal(q([0xe6, 0x97]), '"\\xe6\\x97"');
});

test('bytesToGoString round-trips ASCII and preserves byte identity', () => {
  const s = bytesToGoString(Uint8Array.from([0x2e, 0x70, 0x64, 0x61, 0x74, 0x61]));
  assert.equal(s, '.pdata');
  // Section-name comparison must keep working after the decode change.
  assert.equal(bytesToGoString(Uint8Array.from([0x2e, 0x74, 0x65, 0x78, 0x74])), '.text');
});
