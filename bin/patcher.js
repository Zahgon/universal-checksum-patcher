#!/usr/bin/env node
// Port of cmd/patcher/main.go — the end-user tool. Drop it next to a supported
// Paradox exe (or drag the exe onto it) and run. Detection is config-driven
// (signatures.json, embedded, overridable by a sibling file).

import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { loadConfig } from '../src/core/config.js';
import { openImage } from '../src/core/image.js';
import {
  patchImage, StatusAmbig, StatusError, StatusNoMatch,
} from '../src/core/patch.js';
import {
  backupIfAbsent, ErrChangedOnDisk, restoreFromBackup, writePatched,
} from '../src/core/backup.js';
import { isPermission } from '../src/internal/goerrors.js';
import { newStyle } from '../src/cli/style.js';
import { selectOne } from '../src/cli/prompt.js';

const stTitle = newStyle().bold().foreground(231).background(63).padding(0, 1);
const stOK = newStyle().foreground(42).bold();
const stWarn = newStyle().foreground(214);
const stErr = newStyle().foreground(203).bold();
const stDim = newStyle().foreground(245);
const stName = newStyle().bold().foreground(81);

function parseArgs(args) {
  let action = '';
  let pathArg = '';
  for (const a of args) {
    const lower = a.toLowerCase();
    if (lower === 'patch' || lower === 'restore' || lower === 'status') {
      action = lower;
    } else {
      try {
        if (!statSync(a).isDirectory()) pathArg = a;
      } catch {
        // Go's os.Stat error is discarded here; a non-existent path is simply
        // not treated as a target.
      }
    }
  }
  return { action, pathArg };
}

// detect finds target exes: an explicit drag-dropped path, else the current dir
// plus one level of subdirectories (so EU5's binaries\ folder is found).
function detect(cfg, pathArg) {
  const out = [];
  const seen = new Set();
  const add = (name, path) => {
    if (seen.has(name)) return;
    const g = cfg.games[name];
    if (g !== undefined) {
      seen.add(name);
      out.push({ name, path, game: g, img: null, results: [], patched: null, changed: false, openErr: null });
    }
  };
  if (pathArg !== '') {
    add(basename(pathArg), pathArg);
    return out;
  }
  let entries;
  try {
    entries = readDirSorted('.');
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) add(e.name, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      for (const f of readDirSorted(e.name)) {
        if (!f.isDirectory()) add(f.name, join(e.name, f.name));
      }
    } catch {
      // Go skips unreadable subdirectories without reporting.
    }
  }
  return out;
}

// os.ReadDir returns entries sorted by filename; Node does not guarantee order.
function readDirSorted(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => compareBytes(a.name, b.name));
}

// sort.Strings orders by UTF-8 bytes, not UTF-16 code units.
export function compareBytes(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

function load(t) {
  try {
    t.img = openImage(t.path);
  } catch (err) {
    t.openErr = err;
    return;
  }
  const { results, patched, changed } = patchImage(t.img, t.game);
  t.results = results;
  t.patched = patched;
  t.changed = changed;
}

function showStatus(targets) {
  console.log();
  for (const t of targets) {
    const label = stName.render(t.path);
    if (t.openErr !== null) {
      console.log(`  ${label}  ${stErr.render(`cannot read: ${t.openErr.message}`)}`);
    } else if (blocking(t.results)) {
      console.log(`  ${label}  ${stWarn.render('not supported on this version')}`);
    } else if (t.changed) {
      console.log(`  ${label}  ${stDim.render('ready to patch')}`);
    } else {
      console.log(`  ${label}  ${stOK.render('already patched')}`);
    }
  }
}

async function menu() {
  const choice = await selectOne('What do you want to do?', [
    { label: 'Patch — enable achievements with mods', value: 'patch' },
    { label: 'Restore — undo, revert to original', value: 'restore' },
    { label: 'Quit', value: 'quit' },
  ]);
  return choice === null ? 'quit' : choice;
}

function doPatch(targets) {
  for (const t of targets) {
    const name = stName.render(t.path);
    if (t.openErr !== null) {
      console.log(`  ${name}  ${stErr.render('skipped (cannot read)')}`);
      continue;
    }
    for (const r of t.results) {
      if (r.status === StatusNoMatch || r.status === StatusAmbig) {
        console.log(`  ${name}  ${stWarn.render(`${r.site.id}: ${siteMsg(r)}`)}`);
      }
    }
    if (!t.changed) {
      if (blocking(t.results)) {
        console.log(`  ${name}  ${stWarn.render('not patched — version not supported (run the toolkit / file an issue)')}`);
      } else {
        console.log(`  ${name}  ${stOK.render('already patched — nothing to do')}`);
      }
      continue;
    }
    try {
      const { staleWarning } = backupIfAbsent(t.path, t.img.raw);
      if (staleWarning) {
        console.log(`  ${name}  ${stWarn.render('existing .backup is a different size (older version?) — kept it')}`);
      }
    } catch (err) {
      console.log(`  ${name}  ${permErr('backup failed', err)}`);
      continue;
    }
    try {
      writePatched(t.path, t.img.raw, t.patched);
    } catch (err) {
      if (err === ErrChangedOnDisk) {
        console.log(`  ${name}  ${stErr.render('exe changed on disk mid-run — nothing written, re-run')}`);
      } else {
        console.log(`  ${name}  ${permErr('write failed', err)}`);
      }
      continue;
    }
    console.log(`  ${name}  ${stOK.render('PATCHED ✓  achievements enabled (backup saved)')}`);
  }
  console.log();
  console.log(`${stOK.render('Done.')}${stDim.render('  Launch the game — re-run this after every update. Undo: choose Restore.')}`);
}

function doRestore(targets) {
  for (const t of targets) {
    const name = stName.render(t.path);
    try {
      restoreFromBackup(t.path);
    } catch (err) {
      console.log(`  ${name}  ${permErr('restore failed', err)}`);
      continue;
    }
    console.log(`  ${name}  ${stOK.render('restored to original ✓')}`);
  }
}

// permErr renders a permission error with the actionable Windows fix.
function permErr(prefix, err) {
  if (isPermission(err)) {
    return stErr.render(`${prefix}: permission denied — right-click this program and 'Run as administrator'`);
  }
  return stErr.render(`${prefix}: ${err.message}`);
}

function blocking(results) {
  return results.some(
    (r) => r.status === StatusNoMatch || r.status === StatusAmbig || r.status === StatusError,
  );
}

function siteMsg(r) {
  return r.message !== '' ? r.message : r.status;
}

function gameNames(cfg) {
  return Object.keys(cfg.games).sort(compareBytes);
}

async function pause(interactive) {
  if (!interactive) return;
  console.log();
  process.stdout.write(stDim.render('Press Enter to close...'));
  await new Promise((resolve) => {
    const onData = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main() {
  let { action, pathArg } = parseArgs(process.argv.slice(2));
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  console.log(stTitle.render(' Universal Checksum Patcher ') + stDim.render('  achievements with mods'));
  console.log();

  let cfg;
  let src;
  try {
    ({ cfg, src } = loadConfig('signatures.json'));
  } catch (err) {
    console.log(stErr.render(`Cannot load signatures: ${err.message}`));
    await pause(interactive);
    return;
  }
  console.log(stDim.render(`signatures: ${src} · supports ${gameNames(cfg).join(', ')}`));

  const targets = detect(cfg, pathArg);
  if (targets.length === 0) {
    console.log();
    console.log(stWarn.render('No supported game exe found here.'));
    console.log(stDim.render('Put this next to hoi4.exe / eu4.exe / eu5.exe (EU5: the binaries\\ folder),'));
    console.log(stDim.render("or drag the game's .exe onto this program."));
    await pause(interactive);
    return;
  }
  for (const t of targets) load(t);
  showStatus(targets);

  if (action === '') {
    action = interactive ? await menu() : 'status';
  }

  console.log();
  if (action === 'patch') doPatch(targets);
  else if (action === 'restore') doRestore(targets);
  else if (action === 'quit') console.log(stDim.render('No changes made.'));
  else console.log(stDim.render("Status only (run interactively, or pass 'patch' / 'restore')."));
  await pause(interactive);
}

await main();
