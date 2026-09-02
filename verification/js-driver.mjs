// Emits the same ground-truth record as the Go driver, so the two can be diffed
// field by field. Mirrors verification/go-driver.go.txt case for case.

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePattern, parseBytes, findAll, overlay } from '../src/core/pattern.js';
import { loadConfig } from '../src/core/config.js';
import { applySite, patchImage } from '../src/core/patch.js';
import { Image, openImage } from '../src/core/image.js';
import { findGates, matchInText, stringsInFunc, cStringAt } from '../src/core/discover.js';

const sha = (b) => (b === null ? '<nil>' : createHash('sha256').update(b).digest('hex'));
const arr = (u8) => Array.from(u8);

function tryCall(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, err: err.message, isRange: err instanceof RangeError };
  }
}

const out = {};

const patInputs = [
  '85 C0 ?? 0F', '85 C0', '??', '?', '', '   ', '85 ZZ', '0x85', '85 -1', '85 +1',
  'FF', 'ff', 'Ff', '100', '0', '00', '000', '8', '85\tC0\n?? 0F', ' 85  C0 ',
  '85 C0 ?? 0F 94 ?? E8', '85 C0 0F 94 C3 E8', 'GG', '1G', '85 ??C0', '?? ??',
  '\u00a0', '85\u000bC0', '85\u3000C0', '0X85', ' ', '\n', '85 C0 ', '-0',
];
out.parsePattern = patInputs.map((s) => {
  const r = tryCall(() => parsePattern(s));
  return { in: s, pat: r.ok ? r.value : null, err: r.ok ? '' : r.err };
});

const byteInputs = [
  '85 C0', '', '   ', '85 ZZ', '??', '0x85', 'FF', 'ff', '100', '0', '00',
  '31 C0', 'DE AD BE EF', '99 99', 'CC', '85\tC0', ' 85  C0 ', '-1', '+1', '1G',
];
out.parseBytes = byteInputs.map((s) => {
  const r = tryCall(() => parseBytes(s));
  return { in: s, bytes: r.ok ? arr(r.value) : null, err: r.ok ? '' : r.err };
});

out.findAll = [
  ['85 C0 ?? 0F', [0x00, 0x85, 0xc0, 0x11, 0x0f, 0x85, 0xc0, 0x22, 0x0f, 0x90]],
  ['90', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x90]],
  ['??', [1, 2, 3]],
  ['?? ??', [1, 2, 3]],
  ['DE AD BE EF', [0x90]],
  ['85 C0', []],
  ['85 C0', [0x85]],
  ['85 C0', [0x85, 0xc0]],
  ['00', [0, 0, 0]],
].map(([pat, data]) => ({
  pat,
  data,
  hits: findAll(parsePattern(pat), Uint8Array.from(data)),
}));

out.overlay = [
  ['85 C0 0F 94 ?? E8', 0, [0x31, 0xc0]],
  ['85 C0 0F 94 ?? E8', 4, [0xaa, 0xbb]],
  ['85 C0 0F 94 ?? E8', 5, [0xaa, 0xbb, 0xcc]],
  ['85 C0', 0, []],
  ['80 ?? ?? ?? ?? ?? 00 75 ?? 80', 7, [0xeb]],
].map(([pat, off, repl]) => {
  const p = parsePattern(pat);
  const q = overlay(p, off, Uint8Array.from(repl));
  return { pat, off, repl, out: q, origUnchanged: p };
});

{
  const { cfg, src } = loadConfig('');
  out.loadConfigEmbedded = { src, cfg };
  const r2 = loadConfig('definitely-does-not-exist.json');
  out.loadConfigMissingOverride = { src: r2.src, err: '' };
  const dir = mkdtempSync(join(tmpdir(), 'ucp-'));
  const badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '{not json');
  const r3 = tryCall(() => loadConfig(badPath));
  out.loadConfigBadJSON = {
    srcIsPath: true,
    err: r3.ok ? '' : r3.err.replace(badPath, '<TMP>'),
  };
}

const TEXT_RVA = 0x1000;
const TEXT_FILEOFF = 0x200;
function synthImage(text) {
  const raw = new Uint8Array(TEXT_FILEOFF + text.length + 16);
  raw.set(text, TEXT_FILEOFF);
  return new Image({
    path: '',
    raw,
    base: 0x140000000,
    ptrSize: 8,
    machine: 0x8664,
    sections: [
      {
        name: '.text',
        rva: TEXT_RVA,
        vSize: text.length,
        fileOff: TEXT_FILEOFF,
        rawSize: text.length,
      },
    ],
    pdata: [{ begin: TEXT_RVA, end: TEXT_RVA + text.length }],
  });
}

const gate = {
  id: 'g', anchor: '', find: '85 C0 0F 94 ?? E8', patchOffset: 0,
  expect: '85 C0', replace: '31 C0', requireInFunc: true, expectMatches: 1, note: '',
};
const withGate = (o) => ({ ...gate, ...o });

const applyCases = [
  ['patch', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x11, 0x22, 0x33], gate, true],
  ['notfound', [0x90, 0x90, 0x90, 0x90], gate, true],
  ['ambiguous', [0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x00, 0x85, 0xc0, 0x0f, 0x94, 0xc1, 0xe8, 0x00], gate, true],
  ['expectMismatch', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8], withGate({ expect: '99 99' }), true],
  ['noPdata', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8], gate, false],
  ['badFind', [0x90], withGate({ find: 'ZZ' }), true],
  ['badExpect', [0x90], withGate({ expect: 'ZZ' }), true],
  ['badReplace', [0x90], withGate({ replace: 'ZZ' }), true],
  ['emptyExpect', [0x90], withGate({ expect: '', replace: '' }), true],
  ['lenMismatch', [0x90], withGate({ expect: '85', replace: '31 C0' }), true],
  ['offsetTooBig', [0x90], withGate({ patchOffset: 5 }), true],
  ['negOffset', [0x90], withGate({ patchOffset: -1 }), true],
  ['expectDisagrees', [0x90], withGate({ expect: '84 C0', replace: '31 C0' }), true],
  ['anchorMissing', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8], withGate({ anchor: 'Nope Anchor' }), true],
  ['defaultExpectMatches', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8], withGate({ expectMatches: 0 }), true],
  ['twoWantTwo', [0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x00, 0x85, 0xc0, 0x0f, 0x94, 0xc1, 0xe8, 0x00], withGate({ expectMatches: 2 }), true],
  ['partialPatched', [0x31, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x00, 0x31, 0xc0, 0x0f, 0x94, 0xc1, 0xe8, 0x00], gate, true],
  ['alreadyPatched', [0x90, 0x31, 0xc0, 0x0f, 0x94, 0xc3, 0xe8], gate, true],
  ['noTextSection', null, gate, true],
];

out.applySite = applyCases.map(([name, text, site, pd]) => {
  let img;
  if (text === null) {
    img = new Image({
      path: '', raw: new Uint8Array(64), base: 0x140000000, ptrSize: 8,
      machine: 0x8664, sections: [], pdata: [],
    });
  } else {
    img = synthImage(Uint8Array.from(text));
    if (!pd) img.pdata = [];
  }
  const before = img.raw.slice();
  const r = applySite(img, img.raw, site);
  const bytesEq = before.length === img.raw.length && before.every((b, i) => b === img.raw[i]);
  return {
    name,
    status: r.status,
    count: r.count,
    rvas: r.rvas.length === 0 ? null : r.rvas,
    msg: r.message,
    rawChanged: !bytesEq,
    rawSha: sha(img.raw),
  };
});

const piCases = [
  ['discardOnAmbig', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x90],
    [gate, { ...gate, id: 'bad', anchor: '', find: '90', patchOffset: 0, expect: '90', replace: 'CC', requireInFunc: false, expectMatches: 1 }]],
  ['discardOnNotFound', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x11],
    [gate, { ...gate, id: 'missing', anchor: '', find: 'DE AD BE EF', patchOffset: 0, expect: 'DE', replace: 'FF', requireInFunc: false, expectMatches: 1 }]],
  ['allGood', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x11], [gate]],
  ['allAlready', [0x90, 0x31, 0xc0, 0x0f, 0x94, 0xc3, 0xe8, 0x11], [gate]],
  ['noSites', [0x90, 0x85, 0xc0, 0x0f, 0x94, 0xc3, 0xe8], []],
];

out.patchImage = piCases.map(([name, text, sites]) => {
  const img = synthImage(Uint8Array.from(text));
  const before = img.raw.slice();
  const { results, patched, changed } = patchImage(img, { sites });
  const untouched = before.every((b, i) => b === img.raw[i]);
  return {
    name,
    changed,
    patchedNil: patched === null,
    patchedSha: sha(patched),
    results: results.length === 0 ? null : results.map((r) => ({
      id: r.site.id, status: r.status, count: r.count,
      rvas: r.rvas.length === 0 ? null : r.rvas, msg: r.message,
    })),
    rawUntouched: untouched,
  };
});

{
  const img = openImage(fileURLToPath(new URL('./corpus/toolkit.exe', import.meta.url)));
  const text = img.text();

  const sections = img.sections.map((s) => ({
    name: s.name, rva: s.rva, vsize: s.vSize, fileoff: s.fileOff, rawsize: s.rawSize,
    dataSha: sha(img.bytes(s)), dataLen: img.bytes(s) === null ? 0 : img.bytes(s).length,
  }));

  const pdataHead = img.pdata.slice(0, 40).map((f) => ({ begin: f.begin, end: f.end }));
  const pdBlob = img.pdata.map((f) => `${f.begin}:${f.end};`).join('');

  const rvaProbes = [0, 0x1000, text.rva, text.rva + 1, text.rva + text.vSize - 1,
    text.rva + text.vSize, 0xffffffff, 0x2000, 0x100000];
  const rvaOut = rvaProbes.map((r) => {
    const { off, ok } = img.rvaToFileOff(r);
    const { fr, in: inFunc } = img.funcContains(r);
    return { rva: r, off, ok, inFunc, fnBegin: fr.begin, fnEnd: fr.end };
  });

  const anchors = ['Active Mod Count:', 'runtime', 'GOMAXPROCS', 'toolkit', '',
    'nonexistent-anchor-xyz', 'discover'];
  const anchorOut = anchors.map((a) => {
    const probe = tryCall(() => img.stringVAs(a));
    if (!probe.ok) return { anchor: a, panic: probe.err };
    const vas = probe.value;
    const xr = [];
    for (const v of vas) xr.push(...img.leaXrefRVAs(v));
    const frs = img.funcsReferencingString(a);
    return {
      anchor: a,
      nVAs: vas.length, vas: vas.slice(0, 20),
      nXrefs: xr.length, xrefs: xr.slice(0, 20),
      nFuncs: frs.length,
      funcs: frs.slice(0, 20).map((f) => ({ begin: f.begin, end: f.end })),
    };
  });

  const sif = img.pdata.slice(0, 30).map((fr) => ({
    begin: fr.begin, end: fr.end, strings: stringsInFunc(img, fr),
  }));

  const mit = ['85 C0 0F 94 ?? E8', '84 C0 0F 94 ??', 'CC CC CC CC CC CC CC CC',
    'DE AD BE EF CA FE'].map((p) => {
    const rv = matchInText(img, parsePattern(p));
    return { pat: p, n: rv.length, rvas: rv.slice(0, 25) };
  });

  const gk = ['chievement', 'ronman', 'hecksum', 'mod count', 'andatory',
    'gameapplication', 'application.cpp', 'dlc count'];
  const gAll = findGates(img, []);
  const gKw = findGates(img, gk);
  const trimGate = (c) => ({
    rva: c.rva, bytes: arr(c.bytes), fnBegin: c.func.begin, fnEnd: c.func.end,
    nStrings: c.strings.length, strings: c.strings.slice(0, 8),
  });

  const cs = [];
  for (const va of [0, img.base, img.base + text.rva]) {
    cs.push({ va, s: cStringAt(img, va) });
  }
  const rd = img.section('.rdata');
  if (rd !== null) {
    for (const off of [0, 1, 16, 64, 256, 1024, 4096, 65536]) {
      const va = img.base + rd.rva + off;
      cs.push({ va, s: cStringAt(img, va) });
    }
  }

  out.pe = {
    base: img.base, ptrSize: img.ptrSize, machine: img.machine, isX64: img.isX64(),
    rawLen: img.raw.length, rawSha: sha(img.raw),
    sections, nPdata: img.pdata.length, pdataHead,
    pdataSha: sha(Buffer.from(pdBlob, 'utf8')),
    rvaProbes: rvaOut, anchors: anchorOut, stringsInFunc: sif,
    matchInText: mit,
    findGatesAll: { n: gAll.length, head: gAll.slice(0, 25).map(trimGate) },
    findGatesKw: {
      n: gKw.length,
      head: gKw.slice(0, 25).map((c) => ({
        rva: c.rva, bytes: arr(c.bytes), fnBegin: c.func.begin, fnEnd: c.func.end,
        strings: c.strings.slice(0, 8),
      })),
    },
    cStringAt: cs,
  };
}

// Go's driver ran with cwd=internal/core, where signatures.json sits beside the
// source; match that so the relative paths in the error text line up.
process.chdir(fileURLToPath(new URL('../src/core/', import.meta.url)));
out.openImageErrors = ['does-not-exist.exe', 'signatures.json', '.'].map((p) => {
  const r = tryCall(() => openImage(p));
  return { path: p, err: r.ok ? '' : r.err };
});

const dest = process.env.UCP_TRUTH_OUT ?? '/tmp/js-truth.json';
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`wrote ${dest}`);
