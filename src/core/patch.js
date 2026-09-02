// Port of internal/core/patch.go

import { hexUpper, quote } from '../internal/gostrconv.js';
import { CoreError, findAll, overlay, parseBytes, parsePattern } from './pattern.js';
import { fnKey } from './image.js';

export const StatusPatched = 'patched';
export const StatusAlready = 'already-patched';
export const StatusNoMatch = 'not-found';
export const StatusAmbig = 'ambiguous';
export const StatusError = 'error';

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// patchImage applies every site into a clone of img.raw. Transactional: if any
// site blocks, the clone is discarded and nothing is returned to write.
export function patchImage(img, game) {
  const out = img.raw.slice();
  const results = [];
  let blocking = false;
  let anyPatched = false;
  for (const site of game.sites ?? []) {
    const r = applySite(img, out, site);
    if (r.status === StatusPatched) anyPatched = true;
    else if (r.status !== StatusAlready) blocking = true;
    results.push(r);
  }
  if (blocking || !anyPatched) return { results, patched: null, changed: false };
  return { results, patched: out, changed: true };
}

function errResult(res, msg) {
  res.status = StatusError;
  res.message = msg;
  return res;
}

export function applySite(img, out, site) {
  const res = { site, status: '', count: 0, rvas: [], message: '' };
  let want = site.expectMatches ?? 0;
  if (want === 0) want = 1;

  let find;
  let expect;
  let replace;
  try {
    find = parsePattern(site.find);
  } catch (err) {
    return errResult(res, err.message);
  }
  try {
    expect = parseBytes(site.expect);
  } catch (err) {
    return errResult(res, `expect: ${err.message}`);
  }
  try {
    replace = parseBytes(site.replace);
  } catch (err) {
    return errResult(res, `replace: ${err.message}`);
  }
  const vErr = validateSite(site, find, expect, replace);
  if (vErr !== null) return errResult(res, vErr);

  const text = img.text();
  if (text === null) return errResult(res, 'no .text section');
  const tbytes = img.bytes(text);
  if (tbytes === null) return errResult(res, 'unreadable .text section');

  let anchorRanges = [];
  if ((site.anchor ?? '') !== '') {
    anchorRanges = img.funcsReferencingString(site.anchor);
    if (anchorRanges.length === 0) {
      res.status = StatusNoMatch;
      res.message = `anchor ${quote(site.anchor)} not referenced in code`;
      return res;
    }
  }
  const anchorKeys = new Set(anchorRanges.map(fnKey));

  const keep = (rva) => {
    if (site.requireInFunc === true || anchorRanges.length > 0) {
      const { fr, in: inFunc } = img.funcContains(rva);
      if (!inFunc) return false;
      if (anchorRanges.length > 0 && !anchorKeys.has(fnKey(fr))) return false;
    }
    return true;
  };
  const filter = (offsets) => {
    const kept = [];
    for (const off of offsets) {
      const rva = (text.rva + off) >>> 0;
      if (keep(rva)) kept.push(rva);
    }
    return kept;
  };

  const matches = filter(findAll(find, tbytes));
  res.count = matches.length;

  if (matches.length === 0) {
    const patched = filter(findAll(overlay(find, site.patchOffset, replace), tbytes));
    if (patched.length === want) {
      res.status = StatusAlready;
    } else if (patched.length > 0) {
      res.status = StatusAmbig;
      res.message = `found ${patched.length} patched matches, expected ${want} (partial/foreign patch?)`;
    } else {
      res.status = StatusNoMatch;
    }
    return res;
  }
  if (matches.length !== want) {
    res.status = StatusAmbig;
    res.message = `found ${matches.length} matches, expected ${want}`;
    return res;
  }

  const writes = [];
  for (const rva of matches) {
    const target = (rva + site.patchOffset) >>> 0;
    const { off, ok } = img.rvaToFileOff(target);
    if (!ok || off + replace.length > out.length || off + expect.length > img.raw.length) {
      return errResult(res, `write range out of bounds at RVA 0x${hexUpper(target)}`);
    }
    if (!bytesEqual(img.raw.subarray(off, off + expect.length), expect)) {
      return errResult(res, `expect bytes mismatch at RVA 0x${hexUpper(target)}`);
    }
    writes.push({ off, rva });
  }
  for (const w of writes) {
    out.set(replace, w.off);
    res.rvas.push(w.rva);
  }
  res.status = StatusPatched;
  return res;
}

// validateSite rejects recipes whose patch would fall outside the located match.
// Returns null when valid, else the Go error text.
function validateSite(site, find, expect, replace) {
  if (expect.length === 0 || replace.length === 0) {
    return `site ${site.id}: empty expect/replace`;
  }
  if (expect.length !== replace.length) {
    return `site ${site.id}: expect (${expect.length}) and replace (${replace.length}) must be the same length`;
  }
  if (site.patchOffset < 0 || site.patchOffset + expect.length > find.length) {
    return `site ${site.id}: patchOffset+expect exceeds find pattern length`;
  }
  for (let i = 0; i < expect.length; i++) {
    const b = find[site.patchOffset + i];
    if (b >= 0 && b !== expect[i]) {
      return `site ${site.id}: expect byte ${i} disagrees with find pattern`;
    }
  }
  return null;
}
