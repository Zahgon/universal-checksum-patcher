# Universal Checksum Patcher

Patches Paradox game executables so mods that change the checksum still allow
achievements and ironman. It flips the executable's "game is unmodified" check — the
same edit the Ghidra guides make by hand, done automatically and resilient to updates.

It does not enable the console, cheats, or achievement-disabling game rules.

> JavaScript port of [`IlliaYalovoi/universal-checksum-patcher`](https://github.com/IlliaYalovoi/universal-checksum-patcher)
> (Go). Behavioral equivalence with the Go original is enforced by a differential
> harness — see [Equivalence](#equivalence).

## Supported games

| Game | Windows (x64) |
|------|:--:|
| Hearts of Iron IV (`hoi4.exe`) | ✅ |
| Europa Universalis IV (`eu4.exe`) | ✅ |
| Europa Universalis V (`eu5.exe`) | ✅ |

The patcher reads and rewrites Windows PE executables. It runs anywhere Node does
(the PE parser is pure JavaScript), so you can patch a game exe from macOS or Linux.

## Install & use

```
npm install -g universal-checksum-patcher
```

Or run without installing:

```
npx universal-checksum-patcher
```

1. Run it in the folder containing the game exe, or pass the exe explicitly:
   - HoI4 / EU4: next to `hoi4.exe` / `eu4.exe` (Steam → Manage → Browse local files).
   - EU5: the exe is in the `binaries\` subfolder. Run from the game root or from
     `binaries\`; it scans one level of subfolders.
2. Under `C:\Program Files`, run the terminal as administrator. Writing there needs
   elevation; the tool says so if it hits a permission error.
3. Pick Patch. A `.backup` of the original is saved automatically.

Re-run after every game update — an update replaces the exe with an unpatched one.

Restore reverts to the original. Also scriptable:

```
universal-checksum-patcher patch
universal-checksum-patcher restore
universal-checksum-patcher status
universal-checksum-patcher patch path/to/eu4.exe
```

Without a subcommand it opens an interactive menu on a terminal, and prints status
only when piped.

## How it works

It locates the check by a wildcard byte pattern anchored to a stable engine string
(e.g. HoI4's `Active Mod Count:`) rather than an absolute address, so game updates
don't break the match. Matches are confined to real functions via the `.pdata`
exception table. The patch is transactional: it verifies the exact bytes, backs up
the original, writes atomically, re-checks the file didn't change mid-run, and refuses
ambiguous matches. Running twice is a no-op.

Signatures live in `src/core/signatures.json` (byte-identical to the Go original).
Override them without reinstalling by dropping a `signatures.json` in the working
directory.

## Toolkit

The maintainer's discovery tool, for when a game update breaks a signature:

```
toolkit discover <exe>              find + label candidate gates, suggest a recipe
toolkit match    <exe> "<pattern>"  count/locate a wildcard pattern (?? = any byte)
toolkit anchor   <exe> <string>     show functions that reference a string
toolkit dump     <exe> <rva> <len>  hex-dump bytes at an RVA (hex args)
```

## Library use

```js
import { openImage, loadConfig, patchImage, backupIfAbsent, writePatched } from 'universal-checksum-patcher';

const { cfg } = loadConfig('');
const img = openImage('eu4.exe');
const { results, patched, changed } = patchImage(img, cfg.games['eu4.exe']);
if (changed) {
  backupIfAbsent('eu4.exe', img.raw);
  writePatched('eu4.exe', img.raw, patched);
}
```

### Go → JavaScript name map

| Go | JavaScript |
|---|---|
| `core.OpenImage` | `openImage` |
| `core.LoadConfig` | `loadConfig` → `{ cfg, src }` |
| `core.PatchImage` | `patchImage` → `{ results, patched, changed }` |
| `core.BackupIfAbsent` | `backupIfAbsent` → `{ created, staleWarning }` |
| `core.RestoreFromBackup` | `restoreFromBackup` |
| `core.WritePatched` | `writePatched` |
| `core.ErrChangedOnDisk` | `ErrChangedOnDisk` (frozen singleton) |
| `img.FuncsReferencingString` | `img.funcsReferencingString` |
| `img.FindGates` | `findGates(img, keywords)` |
| `core.ParsePattern` / `ParseBytes` | `parsePattern` / `parseBytes` |

Go returns `(value, error)`; JavaScript has no multi-return, so these functions
**throw** instead. Multi-value returns become objects.

## Build & test

```
npm test       # 48 tests: unit + kernel + differential suites
npm run check  # syntax-check the entry point
```

There is no build step and there are **zero runtime dependencies**, preserving the
Go original's defining property.

## Equivalence

The Go repository is the sole authority on behavior. Three gates enforce it:

| Gate | What it proves | Result |
|---|---|---|
| `test/core.test.js` | The 11 upstream Go tests, ported 1:1 | 11/11, matching the Go baseline exactly (48 total incl. new coverage) |
| `test/differential.test.js` | 200+ recorded Go values across parsing, PE handling and patching | 1 accepted divergence, 0 unexplained |
| `verification/fuzz-diff.mjs` | 130 malformed/truncated/crafted PEs vs. Go's `debug/pe` | 0 divergences |
| `verification/cli-diff.mjs` | Both CLIs diffed against the compiled Go binaries (incl. anchored hoi4 + discover) | 45/45 byte-identical |

`verification/gen-go-baseline.sh` re-derives the baseline from upstream, and CI runs
it on every push, so equivalence is proven rather than assumed.

The single accepted difference is the text of a malformed-`signatures.json` error:
Go's `encoding/json` and JavaScript's `JSON.parse` word it differently. See the
migration report for the full list of intentional differences.

## Credits

Method based on the community Ghidra guide
[How to Play with Mods and Get Achievements](https://steamcommunity.com/sharedfiles/filedetails/?id=2460079052);
EU5 patterns cross-checked against
[UFOdestiny/EU5-Patcher](https://github.com/UFOdestiny/EU5-Patcher).

MIT licensed, as the original.
