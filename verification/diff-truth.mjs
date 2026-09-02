// Diffs the Go and JS ground-truth records field by field and prints every
// divergence with its JSON path.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Defaults to the committed baseline. Pointing at a stale /tmp file instead
// produces a wall of corpus-hash "divergences" that look like real regressions.
const GO_DEFAULT = fileURLToPath(new URL('./go-baseline.json', import.meta.url));
const go = JSON.parse(readFileSync(process.argv[2] ?? GO_DEFAULT, 'utf8'));
const js = JSON.parse(readFileSync(process.argv[3] ?? '/tmp/js-truth.json', 'utf8'));

// The baseline only describes the corpus it was generated from. If the two have
// drifted, say so plainly rather than reporting every PE-derived field.
const corpusPath = fileURLToPath(new URL('./corpus/toolkit.exe', import.meta.url));
const corpusSha = createHash('sha256').update(readFileSync(corpusPath)).digest('hex');
if (go.pe !== undefined && go.pe.rawSha !== corpusSha) {
  console.error('BASELINE/CORPUS DRIFT — regenerate both with verification/gen-go-baseline.sh');
  console.error(`  baseline pe.rawSha: ${go.pe.rawSha}`);
  console.error(`  corpus on disk:     ${corpusSha}`);
  process.exit(2);
}

const diffs = [];

// Go marshals a nil slice as null and an empty slice as []; JavaScript cannot
// distinguish the two, so they are treated as equal.
function normalize(v) {
  if (Array.isArray(v) && v.length === 0) return null;
  if (v === undefined) return null;
  if (v === '' || v === false || v === 0) return null;
  return v;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// encoding/json renders a Go []byte as base64; the JS driver emits a number
// array. Decode so the underlying bytes are what actually gets compared.
function reconcileBytes(a, b) {
  if (typeof a === 'string' && Array.isArray(b) && BASE64.test(a)) {
    return [Array.from(Buffer.from(a, 'base64')), b];
  }
  return [a, b];
}

function walk(path, a, b) {
  [a, b] = reconcileBytes(a, b);
  a = normalize(a);
  b = normalize(b);
  if (a === null && b === null) return;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      diffs.push([path, a, b]);
      return;
    }
    if (a.length !== b.length) {
      diffs.push([`${path}.length`, a.length, b.length]);
      return;
    }
    for (let i = 0; i < a.length; i++) walk(`${path}[${i}]`, a[i], b[i]);
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) walk(`${path}.${k}`, a[k], b[k]);
    return;
  }
  if (a !== b) diffs.push([path, a, b]);
}

for (const key of new Set([...Object.keys(go), ...Object.keys(js)])) {
  walk(key, go[key], js[key]);
}

// Go's encoding/json and JavaScript's JSON.parse word the same malformed input
// differently. It is documented as accepted difference A1, so it must not fail
// CI — but it is listed explicitly, so any *other* divergence still does.
const ACCEPTED = new Set(['loadConfigBadJSON.err']);

const show = (v) => JSON.stringify(v);
const unexpected = diffs.filter(([p]) => !ACCEPTED.has(p));
const accepted = diffs.filter(([p]) => ACCEPTED.has(p));

if (diffs.length === 0) {
  console.log('ZERO DIVERGENCES');
} else {
  console.log(`${diffs.length} DIVERGENCE(S) (${accepted.length} accepted, ${unexpected.length} unexpected):\n`);
  for (const [p, a, b] of diffs.slice(0, 80)) {
    const tag = ACCEPTED.has(p) ? ' [ACCEPTED — A1]' : '';
    console.log(`  ${p}${tag}\n    go: ${show(a)}\n    js: ${show(b)}`);
  }
  if (diffs.length > 80) console.log(`  ... ${diffs.length - 80} more`);
}
if (unexpected.length === 0) console.log('\nNo unexpected divergences.');
process.exit(unexpected.length === 0 ? 0 : 1);
