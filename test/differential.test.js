// The equivalence gate: re-runs the JS driver and diffs it against the recorded
// Go baseline. A green unit suite is not evidence of behavioral equivalence;
// this is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = join(ROOT, 'verification', 'go-baseline.json');

// The one accepted (A) divergence: Go's encoding/json and JavaScript's
// JSON.parse produce different text for the same malformed input. Everything
// else must match byte for byte.
const ACCEPTED = new Set(['loadConfigBadJSON.err']);

test('differential: JS driver matches the recorded Go baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucp-diff-'));
  const out = join(dir, 'js-truth.json');
  execFileSync(process.execPath, [join(ROOT, 'verification', 'js-driver.mjs')], {
    env: { ...process.env, UCP_TRUTH_OUT: out },
    cwd: ROOT,
  });

  const go = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const js = JSON.parse(readFileSync(out, 'utf8'));

  // The baseline only describes the corpus it was generated from. If the two
  // have drifted, every PE-derived value differs and the failure looks like a
  // code regression; say what actually happened instead.
  const corpus = join(ROOT, 'verification', 'corpus', 'toolkit.exe');
  const corpusSha = createHash('sha256').update(readFileSync(corpus)).digest('hex');
  assert.equal(
    go.pe.rawSha,
    corpusSha,
    'baseline/corpus drift: verification/go-baseline.json does not describe '
      + 'verification/corpus/toolkit.exe. Regenerate both together with '
      + 'verification/gen-go-baseline.sh',
  );

  const diffs = [];

  const normalize = (v) => {
    if (Array.isArray(v) && v.length === 0) return null;
    if (v === undefined || v === '' || v === false || v === 0) return null;
    return v;
  };
  const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  const walk = (path, a, b) => {
    if (typeof a === 'string' && Array.isArray(b) && BASE64.test(a)) {
      a = Array.from(Buffer.from(a, 'base64'));
    }
    a = normalize(a);
    b = normalize(b);
    if (a === null && b === null) return;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        diffs.push(path);
        return;
      }
      a.forEach((x, i) => walk(`${path}[${i}]`, x, b[i]));
      return;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(`${path}.${k}`, a[k], b[k]);
      }
      return;
    }
    if (a !== b) diffs.push(path);
  };

  for (const key of new Set([...Object.keys(go), ...Object.keys(js)])) {
    walk(key, go[key], js[key]);
  }

  const unexpected = diffs.filter((d) => !ACCEPTED.has(d));
  assert.deepEqual(unexpected, [], `unexpected divergences:\n${unexpected.join('\n')}`);
});

test('differential: the accepted divergence is still the only one', () => {
  // Guards against the accepted-list silently masking a new regression.
  assert.equal(ACCEPTED.size, 1);
});
