# Universal Checksum Patcher

Patches Paradox game executables so mods that change the checksum still allow
achievements and ironman. It flips the executable's "game is unmodified" check — the
same edit the Ghidra guides make by hand, done automatically and resilient to updates.

It does not enable the console, cheats, or achievement-disabling game rules.

## Supported games

| Game | Windows (x64) |
|------|:--:|
| Hearts of Iron IV (`hoi4.exe`) | ✅ |
| Europa Universalis IV (`eu4.exe`) | ✅ |
| Europa Universalis V (`eu5.exe`) | ✅ |

No Linux/macOS builds.

## Install & use

1. Download `universal-checksum-patcher.exe` from Releases.
2. Put it next to the game exe and run it, or drag the exe onto it:
   - HoI4 / EU4: next to `hoi4.exe` / `eu4.exe` (Steam → Manage → Browse local files).
   - EU5: the exe is in the `binaries\` subfolder. Drop the patcher in the game root
     or in `binaries\`; it scans one level of subfolders.
3. Under `C:\Program Files`, right-click → Run as administrator. Writing there needs
   elevation; the tool says so if it hits a permission error.
4. Pick Patch. A `.backup` of the original is saved automatically.

Re-run after every game update — an update replaces the exe with an unpatched one.

Restore reverts to the original. Also scriptable:
`universal-checksum-patcher.exe patch` / `restore` / `status`.

## How it works

It locates the check by a wildcard byte pattern anchored to a stable engine string
(e.g. HoI4's `Active Mod Count:`) rather than an absolute address, so game updates
don't break the match. Matches are confined to real functions via the `.pdata`
exception table. The patch is transactional: it verifies the exact bytes, backs up
the original, writes atomically, re-checks the file didn't change mid-run, and refuses
ambiguous matches. Running twice is a no-op.

Signatures live in `internal/core/signatures.json` (embedded). Override them without
rebuilding by dropping a `signatures.json` next to the exe.

## Build from source

```
make build   # cross-compiles the Windows exe (amd64) into build/
make test    # runs unit tests
```

Requires Go 1.24+.

## Credits

Method based on the community Ghidra guide
[How to Play with Mods and Get Achievements](https://steamcommunity.com/sharedfiles/filedetails/?id=2460079052);
EU5 patterns cross-checked against
[UFOdestiny/EU5-Patcher](https://github.com/UFOdestiny/EU5-Patcher).
