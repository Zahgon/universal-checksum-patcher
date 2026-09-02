// Port of internal/core/config.go

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from './pattern.js';
import { isNotExist, wrapFsError } from '../internal/goerrors.js';

// Go embeds signatures.json with go:embed. The file is kept byte-identical and
// read from beside this module, so overriding it still requires a rebuild-free
// sibling file exactly as upstream.
const EMBEDDED_PATH = join(import.meta.dirname, 'signatures.json');

export function embeddedSignatures() {
  return readFileSync(EMBEDDED_PATH, 'utf8');
}

// json.Unmarshal is strictly typed: a string where an int is expected is an
// error, not a coercion. Without this, a quoted "patchOffset" would survive into
// `rva + site.patchOffset`, where + concatenates instead of adding and the
// result is written to a completely different address. Go rejects that file;
// so must this.
// The kind names encoding/json puts in an UnmarshalTypeError. They are Go's
// vocabulary, not JavaScript's — "bool" rather than "boolean" — so they are
// pinned here as data rather than spelled inline at each branch.
const GO_JSON_KIND = Object.freeze({
  null: 'null',
  array: 'array',
  number: 'number',
  string: 'string',
  bool: 'bool',
  object: 'object',
});

// Go spells out the numeric literal only when a number fails to fit an integer
// field; every other mismatch reports the bare kind.
function jsonKind(v, withLiteral) {
  if (v === null) return GO_JSON_KIND.null;
  if (Array.isArray(v)) return GO_JSON_KIND.array;
  if (typeof v === 'number') {
    return withLiteral ? `${GO_JSON_KIND.number} ${v}` : GO_JSON_KIND.number;
  }
  if (typeof v === 'string') return GO_JSON_KIND.string;
  if (typeof v === 'boolean') return GO_JSON_KIND.bool;
  return GO_JSON_KIND.object;
}

function typeError(value, path, goType, withLiteral = false) {
  return new CoreError(
    `json: cannot unmarshal ${jsonKind(value, withLiteral)} into Go struct field ${path} of type ${goType}`,
  );
}

// A failure at the top level has no enclosing struct field, so Go words it
// differently.
function topLevelTypeError(value, goType) {
  return new CoreError(
    `json: cannot unmarshal ${jsonKind(value, false)} into Go value of type ${goType}`,
  );
}

// Go matches an exact field name first, then falls back to a case-insensitive
// match, so "PatchOffset" and "patchoffset" both bind to PatchOffset.
function pick(obj, name) {
  if (Object.hasOwn(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

function wantString(obj, name, path) {
  const v = pick(obj, name);
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw typeError(v, `${path}.${name}`, 'string');
  return v;
}

function wantInt(obj, name, path) {
  const v = pick(obj, name);
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw typeError(v, `${path}.${name}`, 'int', true);
  }
  return v;
}

function wantBool(obj, name, path) {
  const v = pick(obj, name);
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw typeError(v, `${path}.${name}`, 'bool');
  return v;
}

function normalizeSite(raw, path) {
  if (raw === null || raw === undefined) return normalizeSite({}, path);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw typeError(raw, path, 'core.Site');
  }
  return {
    id: wantString(raw, 'id', path),
    anchor: wantString(raw, 'anchor', path),
    find: wantString(raw, 'find', path),
    patchOffset: wantInt(raw, 'patchOffset', path),
    expect: wantString(raw, 'expect', path),
    replace: wantString(raw, 'replace', path),
    requireInFunc: wantBool(raw, 'requireInFunc', path),
    expectMatches: wantInt(raw, 'expectMatches', path),
    note: wantString(raw, 'note', path),
  };
}

function normalizeConfig(raw) {
  const games = Object.create(null);
  if (raw === null || raw === undefined) return { games };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw topLevelTypeError(raw, 'core.Config');
  }
  const rawGames = pick(raw, 'games');
  if (rawGames === null || rawGames === undefined) return { games };
  if (typeof rawGames !== 'object' || Array.isArray(rawGames)) {
    throw typeError(rawGames, 'Config.games', 'map[string]core.Game');
  }
  // Object.create(null) because Go map keys such as __proto__ are legal and
  // must not reach Object.prototype.
  for (const [name, game] of Object.entries(rawGames)) {
    if (game === null || game === undefined) {
      games[name] = { sites: [] };
      continue;
    }
    if (typeof game !== 'object' || Array.isArray(game)) {
      throw typeError(game, 'Game.games', 'core.Game');
    }
    const rawSites = pick(game, 'sites');
    if (rawSites === null || rawSites === undefined) {
      games[name] = { sites: [] };
      continue;
    }
    if (!Array.isArray(rawSites)) {
      throw typeError(rawSites, 'Game.games.sites', '[]core.Site');
    }
    games[name] = {
      sites: rawSites.map((s) => normalizeSite(s, 'Site.games.sites')),
    };
  }
  return { games };
}

export function loadConfig(overridePath) {
  let src = 'embedded';
  let raw = embeddedSignatures();
  if (overridePath !== '') {
    try {
      raw = readFileSync(overridePath, 'utf8');
      src = overridePath;
    } catch (err) {
      if (!isNotExist(err)) {
        throw new CoreError(
          `read override ${overridePath}: ${wrapFsError(err, overridePath)}`,
          err,
        );
      }
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CoreError(`parse signatures (${src}): ${err.message}`, err);
  }
  return { cfg: normalizeConfig(parsed), src };
}
