// Drives the Go binaries and the JavaScript ports over identical scenarios and
// diffs stdout, stderr and the exit code. Colour is forced off so both sides
// take lipgloss's plain (non-TTY) path.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { buildFixture } from './make-fixture.mjs';
import { buildDiscoverFixture } from './make-discover-fixture.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CORPUS = join(HERE, 'corpus', 'toolkit.exe');
const GO_TOOLKIT = process.env.GO_TOOLKIT ?? '/tmp/gotoolkit';
const GO_PATCHER = process.env.GO_PATCHER ?? '/tmp/gopatcher';
const JS_TOOLKIT = join(HERE, '..', 'bin', 'toolkit.js');
const JS_PATCHER = join(HERE, '..', 'bin', 'patcher.js');

const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
delete env.CLICOLOR_FORCE;

// Without this, a missing or stale Go binary shows up as 45 unexplained
// scenario diffs rather than a missing prerequisite. Verify up front that each
// path exists and is actually this program, so a wrong binary cannot be
// mistaken for a behavioural divergence.
function requireGoBinary(label, path, probeArgs, expect) {
  if (!existsSync(path)) {
    console.error(`cli-diff: ${label} not found: ${path}`);
    console.error('Build the Go binaries first (requires a Go toolchain):');
    console.error('  ./verification/gen-go-baseline.sh');
    console.error(`or set ${label} to an existing build.`);
    process.exit(2);
  }
  const probe = spawnSync(path, probeArgs, { env, encoding: 'utf8', timeout: 60000 });
  const text = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (!text.includes(expect)) {
    console.error(`cli-diff: ${path} does not look like the Go ${label}.`);
    console.error(`  expected output containing ${JSON.stringify(expect)}`);
    console.error(`  got: ${JSON.stringify(text.slice(0, 120))}`);
    console.error('Rebuild with ./verification/gen-go-baseline.sh');
    process.exit(2);
  }
}

requireGoBinary('GO_TOOLKIT', GO_TOOLKIT, [], 'toolkit — maintainer discovery tool');
requireGoBinary('GO_PATCHER', GO_PATCHER, ['status'], 'Universal Checksum Patcher');

function run(cmd, args, cwd) {
  // The dump command can emit several MiB; the default 1 MiB maxBuffer would
  // truncate both sides at different points and manufacture a false diff.
  const r = spawnSync(cmd, args, {
    cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const results = [];
function record(name, go, js, opts = {}) {
  const norm = opts.normalize ?? ((x) => x);
  const same =
    norm(go.stdout) === norm(js.stdout) &&
    (opts.ignoreStderr === true || norm(go.stderr) === norm(js.stderr)) &&
    (opts.ignoreCode === true || go.code === js.code);
  results.push({ name, same, go, js, opts });
}

// ---- toolkit scenarios -----------------------------------------------------
const toolkitScenarios = [
  ['no args', []],
  ['discover', ['discover', CORPUS]],
  ['match gate', ['match', CORPUS, '85 C0 0F 94 ?? E8']],
  ['match setnz', ['match', CORPUS, '84 C0 0F 94 ??']],
  ['match int3', ['match', CORPUS, 'CC CC CC CC CC CC CC CC']],
  ['match none', ['match', CORPUS, 'DE AD BE EF CA FE']],
  ['match bad pattern', ['match', CORPUS, 'ZZ']],
  ['match empty pattern', ['match', CORPUS, '']],
  ['match multiword', ['match', CORPUS, '85', 'C0']],
  ['anchor runtime', ['anchor', CORPUS, 'runtime']],
  ['anchor missing', ['anchor', CORPUS, 'nonexistent-anchor-xyz']],
  ['anchor GOMAXPROCS', ['anchor', CORPUS, 'GOMAXPROCS']],
  ['dump hex', ['dump', CORPUS, '0x1000', '0x40']],
  ['dump nohex prefix', ['dump', CORPUS, '1000', '40']],
  ['dump bad rva', ['dump', CORPUS, 'zz', '40']],
  ['dump huge rva', ['dump', CORPUS, '0xFFFFFFFFF', '40']],
  ['dump unmapped rva', ['dump', CORPUS, '0x9999999', '0x10']],
  ['dump cap', ['dump', CORPUS, '0x1000', '0xFFFFFFF']],
  ['dump zero len', ['dump', CORPUS, '0x1000', '0']],
  ['bad subcommand', ['bogus', CORPUS]],
  ['missing exe', ['discover', 'does-not-exist.exe']],
  ['not a PE', ['discover', join(HERE, '..', 'src', 'core', 'signatures.json')]],
  ['match missing arg', ['match', CORPUS]],
  ['anchor missing arg', ['anchor', CORPUS]],
  ['dump missing arg', ['dump', CORPUS, '0x1000']],
];

for (const [name, args] of toolkitScenarios) {
  const go = run(GO_TOOLKIT, args, HERE);
  const js = run('node', [JS_TOOLKIT, ...args], HERE);
  // The Go binary prints its own argv[0] and path arguments verbatim; only the
  // program name differs, so normalise the two binaries' own paths away.
  const normalize = (s) => s.split(GO_TOOLKIT).join('<BIN>').split(JS_TOOLKIT).join('<BIN>');
  record(`toolkit: ${name}`, go, js, { normalize });
}

// The stock corpus yields zero keyword-matching gates, so discover's ranking,
// anchor picking and recipe emission would otherwise never run. This fixture
// plants a real gate plus an anchor string and an MD5 in one .pdata function.
const DISCOVER_FIXTURE = join(tmpdir(), 'ucp-discover-fixture.exe');
buildDiscoverFixture(CORPUS, DISCOVER_FIXTURE);

for (const [name, args] of [
  ['discover with a scoring gate', ['discover', DISCOVER_FIXTURE]],
  ['match the planted gate', ['match', DISCOVER_FIXTURE, '85 C0 0F 94 ?? E8']],
  ['anchor on the planted string', ['anchor', DISCOVER_FIXTURE, 'Active Mod Count: ']],
  ['dump the planted gate', ['dump', DISCOVER_FIXTURE, '0x1B20', '0x20']],
]) {
  const go = run(GO_TOOLKIT, args, HERE);
  const js = run('node', [JS_TOOLKIT, ...args], HERE);
  record(`toolkit: ${name}`, go, js);
}

// D1: the empty anchor panics in Go and throws in JavaScript. Compared
// separately because a Go panic prints a goroutine dump that has no analogue.
{
  const go = run(GO_TOOLKIT, ['anchor', CORPUS, ''], HERE);
  const js = run('node', [JS_TOOLKIT, 'anchor', CORPUS, ''], HERE);
  const goPanicked = go.stderr.includes('slice bounds out of range [846849:846848]');
  const jsThrew = js.stderr.includes('slice bounds out of range [846849:846848]');
  results.push({
    name: 'toolkit: D1 empty anchor panics with identical text',
    same: goPanicked && jsThrew && go.code !== 0 && js.code !== 0,
    go, js, opts: {},
  });
}

// ---- patcher scenarios -----------------------------------------------------
function patcherScenario(name, setup, args, exeName = 'eu4.exe') {
  const runOne = (cmd, argv) => {
    const dir = mkdtempSync(join(tmpdir(), 'ucp-cli-'));
    setup(dir);
    const out = run(cmd, argv, dir);
    const files = {};
    for (const f of [exeName, `${exeName}.backup`]) {
      const p = join(dir, f);
      files[f] = existsSync(p)
        ? createHash('sha256').update(readFileSync(p)).digest('hex')
        : null;
    }
    rmSync(dir, { recursive: true, force: true });
    return { ...out, files };
  };
  const go = runOne(GO_PATCHER, args);
  const js = runOne('node', [JS_PATCHER, ...args]);
  const same =
    go.stdout === js.stdout &&
    go.stderr === js.stderr &&
    go.code === js.code &&
    JSON.stringify(go.files) === JSON.stringify(js.files);
  results.push({ name: `patcher: ${name}`, same, go, js, opts: {} });
}

const FIXTURE = join(tmpdir(), 'ucp-eu4-fixture.exe');
buildFixture(CORPUS, FIXTURE);

const empty = () => {};
const withExe = (dir) => copyFileSync(FIXTURE, join(dir, 'eu4.exe'));
const withSubdir = (dir) => {
  const sub = join(dir, 'binaries');
  mkdirSync(sub);
  copyFileSync(FIXTURE, join(sub, 'eu4.exe'));
};
const withPatched = (dir) => {
  withExe(dir);
  run(GO_PATCHER, ['patch'], dir);
};

patcherScenario('empty dir status', empty, []);
patcherScenario('empty dir patch', empty, ['patch']);
patcherScenario('exe present status', withExe, []);
patcherScenario('exe present status arg', withExe, ['status']);
patcherScenario('exe present patch', withExe, ['patch']);
patcherScenario('exe already patched', withPatched, ['patch']);
patcherScenario('exe restore', withPatched, ['restore']);
patcherScenario('restore without backup', withExe, ['restore']);
patcherScenario('explicit path arg', withExe, ['patch', 'eu4.exe']);
patcherScenario('unknown arg', withExe, ['bogus']);
patcherScenario('mixed args', withExe, ['eu4.exe', 'status']);

// The eu4 recipe has no anchor. These exercise the shipped hoi4 recipe, whose
// search is restricted to functions referencing "Active Mod Count:" — the
// string-anchored path, which nothing else covers.
const withHoi4 = (dir) => copyFileSync(DISCOVER_FIXTURE, join(dir, 'hoi4.exe'));
const withHoi4Patched = (dir) => {
  withHoi4(dir);
  run(GO_PATCHER, ['patch'], dir);
};
patcherScenario('anchored hoi4 status', withHoi4, [], 'hoi4.exe');
patcherScenario('anchored hoi4 patch', withHoi4, ['patch'], 'hoi4.exe');
patcherScenario('anchored hoi4 already patched', withHoi4Patched, ['patch'], 'hoi4.exe');
patcherScenario('anchored hoi4 restore', withHoi4Patched, ['restore'], 'hoi4.exe');

// ---- report ----------------------------------------------------------------
const failed = results.filter((r) => !r.same);
for (const r of results) {
  console.log(`${r.same ? 'ok  ' : 'FAIL'}  ${r.name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} scenarios byte-identical`);

for (const r of failed) {
  console.log(`\n--- ${r.name} ---`);
  console.log('GO stdout:', JSON.stringify(r.go.stdout));
  console.log('JS stdout:', JSON.stringify(r.js.stdout));
  console.log('GO stderr:', JSON.stringify(r.go.stderr));
  console.log('JS stderr:', JSON.stringify(r.js.stderr));
  console.log('GO code:', r.go.code, 'JS code:', r.js.code);
  if (r.go.files !== undefined) {
    console.log('GO files:', JSON.stringify(r.go.files));
    console.log('JS files:', JSON.stringify(r.js.files));
  }
}

rmSync(FIXTURE, { force: true });
rmSync(DISCOVER_FIXTURE, { force: true });
process.exit(failed.length === 0 ? 0 : 1);
