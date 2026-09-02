// Go `strconv` + `unicode` surface that JavaScript does not provide.
// Every function here mirrors a Go stdlib function whose exact output is
// externally observable in this program (error strings, %q formatting).

const MAX_LATIN1 = 0xff;

// Go's unicode.properties table marks a Latin-1 code point printable (pp).
// 0x20..0x7E are printable; in 0xA0..0xFF only 0xA0 (NBSP, Zs) and 0xAD
// (soft hyphen, Cf) are NOT. Reproduced as a literal table because Go's
// IsPrint uses this table rather than the general category ranges below 0x100.
function isPrintLatin1(cp) {
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp < 0xa0) return false;
  return cp !== 0xa0 && cp !== 0xad;
}

const PRINT_RANGES = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

// isPrint mirrors Go's unicode.IsPrint: L, M, N, P, S plus ASCII space.
export function isPrint(cp) {
  if (cp <= MAX_LATIN1) return isPrintLatin1(cp);
  if (cp > 0x10ffff) return false;
  return PRINT_RANGES.test(String.fromCodePoint(cp));
}

// Go's unicode.IsSpace (White_Space property). Deliberately NOT JavaScript's
// \s: JS includes U+FEFF, Go does not. strings.Fields depends on this exact set.
const GO_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0,
  0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function isSpaceUnicode(cp) {
  return GO_SPACE.has(cp);
}

// fields mirrors strings.Fields: split around runs of unicode.IsSpace runes.
export function fields(s) {
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (isSpaceUnicode(ch.codePointAt(0))) {
      if (cur !== '') {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

const LOWER_HEX = '0123456789abcdef';

function appendEscapedRune(buf, cp) {
  switch (cp) {
    case 0x07: return buf + '\\a';
    case 0x08: return buf + '\\b';
    case 0x0c: return buf + '\\f';
    case 0x0a: return buf + '\\n';
    case 0x0d: return buf + '\\r';
    case 0x09: return buf + '\\t';
    case 0x0b: return buf + '\\v';
  }
  // Go's condition is `r < ' ' || r == 0x7f`; DEL is not printable and takes
  // the \x form, not \u.
  if (cp < 0x20 || cp === 0x7f) {
    return buf + '\\x' + LOWER_HEX[(cp >> 4) & 0xf] + LOWER_HEX[cp & 0xf];
  }
  let r = cp;
  if (r > 0x10ffff) r = 0xfffd;
  if (r < 0x10000) return buf + '\\u' + r.toString(16).padStart(4, '0');
  return buf + '\\U' + r.toString(16).padStart(8, '0');
}

// quote mirrors strconv.Quote — the `%q` verb. Not JSON.stringify: Go escapes a
// different set (\x00 not \u0000, NBSP escaped, U+2028 escaped, © left literal).
export function quote(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // A byte that was not valid UTF-8 was parked at U+DC00+B by
    // bytesToGoString; Go renders exactly that byte as \xNN.
    if (cp >= 0xdc00 && cp <= 0xdcff) {
      out += '\\x' + (cp - 0xdc00).toString(16).padStart(2, '0');
      continue;
    }
    // Any other lone surrogate cannot occur in a Go string; render its two
    // bytes rather than emitting invalid UTF-16 downstream.
    if (cp >= 0xd800 && cp <= 0xdfff) {
      out += '\\x' + ((cp >> 8) & 0xff).toString(16).padStart(2, '0');
      out += '\\x' + (cp & 0xff).toString(16).padStart(2, '0');
      continue;
    }
    if (ch === '"') { out += '\\"'; continue; }
    if (ch === '\\') { out += '\\\\'; continue; }
    if (isPrint(cp)) { out += ch; continue; }
    out = appendEscapedRune(out, cp);
  }
  return out + '"';
}

// A Go string is arbitrary bytes; a JavaScript string is UTF-16. Decoding raw
// bytes as latin1 would turn an invalid byte such as 0xE8 into a *printable*
// 'è', which %q then prints literally where Go prints \xe8.
//
// So decode exactly as Go's utf8.DecodeRune does, and park each byte that is
// not part of a valid sequence in the low surrogate range (PEP 383 style) so
// quote() can recover and render it as Go does. Byte B maps to U+DC00+B.
const SURROGATE_ESCAPE_BASE = 0xdc00;

function utf8SequenceLength(b0, b1) {
  if (b0 < 0x80) return 1;
  if (b0 < 0xc2) return 0;
  if (b0 < 0xe0) return 2;
  if (b0 === 0xe0) return b1 >= 0xa0 && b1 <= 0xbf ? 3 : 0;
  if (b0 === 0xed) return b1 >= 0x80 && b1 <= 0x9f ? 3 : 0;
  if (b0 < 0xf0) return 3;
  if (b0 === 0xf0) return b1 >= 0x90 && b1 <= 0xbf ? 4 : 0;
  if (b0 === 0xf4) return b1 >= 0x80 && b1 <= 0x8f ? 4 : 0;
  if (b0 < 0xf4) return 4;
  return 0;
}

const isContinuation = (b) => b !== undefined && (b & 0xc0) === 0x80;

export function bytesToGoString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    const n = utf8SequenceLength(b0, bytes[i + 1] ?? -1);
    let ok = n > 0 && i + n <= bytes.length;
    if (ok) {
      for (let k = 1; k < n; k++) {
        if (!isContinuation(bytes[i + k])) { ok = false; break; }
      }
    }
    if (!ok) {
      out += String.fromCharCode(SURROGATE_ESCAPE_BASE + b0);
      i += 1;
      continue;
    }
    let cp = n === 1 ? b0 : b0 & (0x7f >> n);
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

export class NumError extends Error {
  constructor(fn, num, message) {
    super(`strconv.${fn}: parsing ${quote(num)}: ${message}`);
    this.name = 'NumError';
    this.fn = fn;
    this.num = num;
    this.reason = message;
  }
}

export const ERR_SYNTAX = 'invalid syntax';
export const ERR_RANGE = 'value out of range';

function hexDigit(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 + 10;
  return -1;
}

// parseUint mirrors strconv.ParseUint for an explicit base (no 0x prefix, no
// sign, no underscores) and a bitSize cap. Returns {value} or throws NumError.
// parseInt() cannot be used: it accepts prefixes, signs and trailing garbage.
export function parseUint(s, base, bitSize) {
  if (s === '') throw new NumError('ParseUint', s, ERR_SYNTAX);
  const maxVal = (2n ** BigInt(bitSize)) - 1n;
  const cutoff = maxVal / BigInt(base) + 1n;
  const b = BigInt(base);
  let n = 0n;
  // Go iterates the raw bytes of s, so any byte >= 0x80 is a syntax error.
  const bytes = new TextEncoder().encode(s);
  for (const cp of bytes) {
    const d = hexDigit(cp);
    if (d < 0 || d >= base) throw new NumError('ParseUint', s, ERR_SYNTAX);
    if (n >= cutoff) throw new NumError('ParseUint', s, ERR_RANGE);
    n = n * b + BigInt(d);
    if (n > maxVal) throw new NumError('ParseUint', s, ERR_RANGE);
  }
  return Number(n);
}

// atoi mirrors strconv.Atoi's success path for the COFF `/NNN` section-name form.
export function atoi(s) {
  if (s === '') throw new NumError('Atoi', s, ERR_SYNTAX);
  let i = 0;
  let neg = false;
  if (s[0] === '+' || s[0] === '-') {
    neg = s[0] === '-';
    i = 1;
    if (s.length === 1) throw new NumError('Atoi', s, ERR_SYNTAX);
  }
  let n = 0n;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) throw new NumError('Atoi', s, ERR_SYNTAX);
    n = n * 10n + BigInt(c - 0x30);
  }
  const signed = neg ? -n : n;
  // Atoi is int-sized; Go reports a range error rather than losing precision.
  if (signed > 2n ** 63n - 1n || signed < -(2n ** 63n)) {
    throw new NumError('Atoi', s, ERR_RANGE);
  }
  return Number(signed);
}

// hex2 / hexUpper mirror the %02X and %X verbs.
export function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

export function hexUpper(n) {
  return n.toString(16).toUpperCase();
}
