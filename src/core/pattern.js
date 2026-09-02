// Port of internal/core/pattern.go

import { fields, parseUint, quote } from '../internal/gostrconv.js';

export class CoreError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CoreError';
    if (cause !== undefined) this.cause = cause;
  }
}

// A Pattern is an array where -1 means wildcard ("??"), else a concrete 0..255.
export function parsePattern(s) {
  const toks = fields(s);
  if (toks.length === 0) throw new CoreError('empty pattern');
  const p = new Array(toks.length);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '??' || t === '?') {
      p[i] = -1;
      continue;
    }
    try {
      p[i] = parseUint(t, 16, 8);
    } catch (err) {
      throw new CoreError(`bad pattern token ${quote(t)}: ${err.message}`, err);
    }
  }
  return p;
}

export function parseBytes(s) {
  const toks = fields(s);
  const out = new Uint8Array(toks.length);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    try {
      out[i] = parseUint(t, 16, 8);
    } catch (err) {
      throw new CoreError(`bad byte token ${quote(t)}: ${err.message}`, err);
    }
  }
  return out;
}

function matchAt(p, data, i) {
  if (i + p.length > data.length) return false;
  for (let k = 0; k < p.length; k++) {
    const b = p[k];
    if (b >= 0 && data[i + k] !== b) return false;
  }
  return true;
}

export function findAll(p, data) {
  const out = [];
  for (let i = 0; i + p.length <= data.length; i++) {
    if (matchAt(p, data, i)) out.push(i);
  }
  return out;
}

// overlay returns a copy of the pattern with concrete bytes written at off —
// used to derive the "already patched" pattern.
export function overlay(p, off, repl) {
  const q = p.slice();
  for (let i = 0; i < repl.length; i++) {
    if (off + i < q.length) q[off + i] = repl[i];
  }
  return q;
}
