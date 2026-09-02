#!/usr/bin/env node
// Port of cmd/toolkit/main.go — the maintainer's discovery tool. When a game
// update breaks a signature, point it at the new exe: it finds the
// checksum/achievement gate by shape + the strings its function references, and
// prints a ready-to-paste recipe.
//
// Usage:
//
//	toolkit discover <exe>              find + label candidate gates, suggest a recipe
//	toolkit match    <exe> "<pattern>" count/locate a wildcard pattern (?? = any byte)
//	toolkit anchor   <exe> <string>    show functions that reference a string
//	toolkit dump     <exe> <rva> <len> hex-dump bytes at an RVA

import { writeSync } from 'node:fs';

import { openImage } from '../src/core/image.js';
import { parsePattern } from '../src/core/pattern.js';
import { findGates, matchInText, stringsInFunc } from '../src/core/discover.js';
import { hex2, hexUpper, parseUint, quote } from '../src/internal/gostrconv.js';

const MAX_UINT32 = 0xffffffff;

// process.stdout.write is asynchronous when stdout is a pipe, so a subsequent
// process.exit can discard buffered output. Go's fmt.Print writes straight to
// the fd, so every exit path here must too. Short writes are looped over
// because a pipe may accept fewer bytes than offered.
function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

const stdout = (text) => writeAll(1, text);
const stderr = (text) => writeAll(2, text);

// keywords that make a checksum/achievement/ironman gate self-identify.
const gateKeywords = [
  'chievement', 'ronman', 'hecksum', 'mod count', 'andatory',
  'gameapplication', 'application.cpp', 'dlc count',
];

function usage() {
  stderr(`toolkit — maintainer discovery tool
  toolkit discover <exe>              find + label candidate gates, suggest a recipe
  toolkit match    <exe> "<pattern>" count/locate a wildcard pattern (?? = any byte)
  toolkit anchor   <exe> <string>    show functions referencing a string
  toolkit dump     <exe> <rva> <len> hex-dump bytes at an RVA (hex args)\n`);
}

function trim(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

function hexBytes(b) {
  return Array.from(b, (x) => hex2(x)).join(' ');
}

function isMD5(s) {
  if (s.length !== 32) return false;
  for (const c of s) {
    const ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    if (!ok) return false;
  }
  return true;
}

// score weights a function's strings toward the specific checksum gate: the
// killer combo is a version/mod dump ("Active Mod Count" + an MD5 hash).
const SCORE_WEIGHTS = [
  ['mod count', 10], ['dlc count', 4],
  ['gameapplication', 3], ['eu4application', 3], ['session.cpp', 3],
  ['synchronizationmanager', 3],
  ['checksum', 2], ['chievement', 1], ['ronman', 1],
];

function score(strs) {
  const blob = strs.join('\u0000').toLowerCase();
  let s = 0;
  for (const [kw, w] of SCORE_WEIGHTS) {
    if (blob.includes(kw)) s += w;
  }
  for (const str of strs) {
    if (isMD5(str)) {
      s += 8;
      break;
    }
  }
  return s;
}

function pickAnchor(strs) {
  for (const k of gateKeywords) {
    for (const s of strs) {
      if (s.toLowerCase().includes(k) && !s.includes('\\') && s.length < 40) return s;
    }
  }
  return '';
}

// suggestRecipe emits a paste-ready signatures.json site for a test;setcc gate.
function suggestRecipe(c) {
  const anchor = pickAnchor(c.strings);
  const anchorLine = anchor !== '' ? `      "anchor": ${quote(anchor)},\n` : '';
  return `    {
      "id": "checksum_gate",
${anchorLine}      "find": "85 C0 0F 94 ?? E8",
      "patchOffset": 0,
      "expect": "85 C0",
      "replace": "31 C0",
      "requireInFunc": true,
      "expectMatches": 1
    }`;
}

function discover(img) {
  const cands = findGates(img, gateKeywords);
  // sort.SliceStable with a `score(a) > score(b)` less-function; Array.sort is
  // stable, so a descending comparator reproduces it exactly.
  cands.sort((a, b) => score(b.strings) - score(a.strings));

  stdout(
    `gate candidates: ${cands.length} (showing top ${Math.min(cands.length, 6)} by relevance)\n\n`,
  );
  for (let i = 0; i < cands.length; i++) {
    if (i >= 6) break;
    const c = cands[i];
    stdout(
      `[${i + 1}] score ${score(c.strings)}  RVA 0x${hexUpper(c.rva)}  gate ${hexBytes(c.bytes)}  func[0x${hexUpper(c.func.begin)}..0x${hexUpper(c.func.end)}]\n`,
    );
    stdout(`    strings: ${trim(c.strings, 6).join(' | ')}\n`);
    if (i === 0) {
      stdout(`    suggested recipe (verify with \`toolkit match\`):\n${suggestRecipe(c)}\n`);
    }
    stdout('\n');
  }
  if (cands.length === 0) {
    stdout('No test;setcc gate matched the keyword filter.\n');
    stdout("The gate may be a different shape (e.g. EU5's cmp-byte-flag chain).\n");
    stdout('Use `toolkit match <exe> "<pattern>"` to test a candidate pattern,\n');
    stdout('or `toolkit anchor <exe> CanGetAchievements` to locate a named gate.\n');
  }
}

function matchCmd(img, pattern) {
  let p;
  try {
    p = parsePattern(pattern);
  } catch (err) {
    stderr(`${err.message}\n`);
    process.exit(1);
  }
  const rvas = matchInText(img, p);
  stdout(`pattern ${quote(pattern)} -> ${rvas.length} match(es)\n`);
  for (let i = 0; i < rvas.length; i++) {
    if (i >= 25) {
      stdout(`  ... ${rvas.length - 25} more\n`);
      break;
    }
    const rva = rvas[i];
    let label = '(not in a .pdata function)';
    const { fr, in: inFunc } = img.funcContains(rva);
    if (inFunc) {
      label = `func[0x${hexUpper(fr.begin)}..0x${hexUpper(fr.end)}] strings=${trim(stringsInFunc(img, fr), 5).join(' | ')}`;
    }
    stdout(`  RVA 0x${hexUpper(rva)}  ${label}\n`);
  }
}

function anchorCmd(img, s) {
  const frs = img.funcsReferencingString(s);
  stdout(`functions referencing ${quote(s)}: ${frs.length}\n`);
  for (const fr of frs) {
    stdout(
      `  func[0x${hexUpper(fr.begin)}..0x${hexUpper(fr.end)}]  strings=${trim(stringsInFunc(img, fr), 6).join(' | ')}\n`,
    );
  }
}

function dumpCmd(img, rvaStr, lenStr) {
  let rva64;
  let n64;
  let bad = false;
  try {
    rva64 = parseUint(stripHexPrefix(rvaStr), 16, 64);
  } catch {
    bad = true;
  }
  try {
    n64 = parseUint(stripHexPrefix(lenStr), 16, 64);
  } catch {
    bad = true;
  }
  if (bad) {
    stderr('rva and len must be hex, e.g. 0x16ECD0 0x40\n');
    process.exit(1);
  }
  if (rva64 > MAX_UINT32) {
    stderr('rva out of range\n');
    process.exit(1);
  }
  if (n64 > 1 << 20) n64 = 1 << 20;
  const { off, ok } = img.rvaToFileOff(rva64 >>> 0);
  if (!ok) {
    stderr('RVA not in a raw-backed section\n');
    process.exit(1);
  }
  for (let row = 0; row < n64; row += 16) {
    stdout(`  0x${hexUpper(((rva64 >>> 0) + row) >>> 0)}: `);
    for (let col = 0; col < 16 && row + col < n64 && off + row + col < img.raw.length; col++) {
      stdout(`${hex2(img.raw[off + row + col])} `);
    }
    stdout('\n');
  }
}

function stripHexPrefix(s) {
  const lower = s.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

function main() {
  const argv = process.argv.slice(1);
  if (argv.length < 3) {
    usage();
    process.exit(2);
  }
  const cmd = argv[1];
  const exe = argv[2];
  let img;
  try {
    img = openImage(exe);
  } catch (err) {
    stderr(`${err.message}\n`);
    process.exit(1);
  }
  stdout(`${exe}  ImageBase 0x${hexUpper(img.base)}  x64=${img.isX64()}\n\n`);

  switch (cmd) {
    case 'discover':
      discover(img);
      break;
    case 'match':
      if (argv.length < 4) {
        usage();
        process.exit(2);
      }
      matchCmd(img, argv.slice(3).join(' '));
      break;
    case 'anchor':
      if (argv.length < 4) {
        usage();
        process.exit(2);
      }
      anchorCmd(img, argv[3]);
      break;
    case 'dump':
      if (argv.length < 5) {
        usage();
        process.exit(2);
      }
      dumpCmd(img, argv[3], argv[4]);
      break;
    default:
      usage();
      process.exit(2);
  }
}

main();
