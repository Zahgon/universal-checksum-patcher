// Command patcher is the end-user tool. Drop it next to a supported Paradox exe
// (or drag the exe onto it) and run. It patches the checksum/achievement gate so
// mods that change the checksum still allow achievements. Detection is
// config-driven (signatures.json, embedded, overridable by a sibling file).
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-isatty"

	"github.com/IlliaYalovoi/universal-checksum-patcher/internal/core"
)

var (
	stTitle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("231")).Background(lipgloss.Color("63")).Padding(0, 1)
	stOK    = lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
	stWarn  = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	stErr   = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true)
	stDim   = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	stName  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("81"))
)

// target is a detected game exe plus the result of a dry patch pass.
type target struct {
	name    string
	path    string
	game    core.Game
	img     *core.Image
	results []core.SiteResult
	patched []byte
	changed bool
	openErr error
}

func main() {
	action, pathArg := parseArgs(os.Args[1:])
	interactive := isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())

	fmt.Println(stTitle.Render(" Universal Checksum Patcher ") + stDim.Render("  achievements with mods"))
	fmt.Println()

	cfg, src, err := core.LoadConfig("signatures.json")
	if err != nil {
		fmt.Println(stErr.Render("Cannot load signatures: " + err.Error()))
		pause(interactive)
		return
	}
	fmt.Println(stDim.Render(fmt.Sprintf("signatures: %s · supports %s", src, strings.Join(gameNames(cfg), ", "))))

	targets := detect(cfg, pathArg)
	if len(targets) == 0 {
		fmt.Println()
		fmt.Println(stWarn.Render("No supported game exe found here."))
		fmt.Println(stDim.Render("Put this next to hoi4.exe / eu4.exe / eu5.exe (EU5: the binaries\\ folder),"))
		fmt.Println(stDim.Render("or drag the game's .exe onto this program."))
		pause(interactive)
		return
	}
	for i := range targets {
		load(&targets[i])
	}
	showStatus(targets)

	// Decide the action: explicit arg, else interactive menu, else status-only.
	if action == "" {
		if interactive {
			action = menu()
		} else {
			action = "status"
		}
	}

	fmt.Println()
	switch action {
	case "patch":
		doPatch(targets)
	case "restore":
		doRestore(targets)
	case "quit":
		fmt.Println(stDim.Render("No changes made."))
	default: // status
		fmt.Println(stDim.Render("Status only (run interactively, or pass 'patch' / 'restore')."))
	}
	pause(interactive)
}

func parseArgs(args []string) (action, pathArg string) {
	for _, a := range args {
		switch strings.ToLower(a) {
		case "patch", "restore", "status":
			action = strings.ToLower(a)
		default:
			if fi, err := os.Stat(a); err == nil && !fi.IsDir() {
				pathArg = a
			}
		}
	}
	return
}

// detect finds target exes: an explicit drag-dropped path, else the current dir
// plus one level of subdirectories (so EU5's binaries\ folder is found).
func detect(cfg *core.Config, pathArg string) []target {
	var out []target
	seen := map[string]bool{} // dedupe by exe name; first (shallowest) wins
	add := func(name, path string) {
		if seen[name] {
			return
		}
		if g, ok := cfg.Games[name]; ok {
			seen[name] = true
			out = append(out, target{name: name, path: path, game: g})
		}
	}
	if pathArg != "" {
		add(filepath.Base(pathArg), pathArg)
		return out
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		return out
	}
	// Pass 1: cwd (preferred). Pass 2: one level of subdirs (EU5's binaries\).
	for _, e := range entries {
		if !e.IsDir() {
			add(e.Name(), e.Name())
		}
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if sub, err := os.ReadDir(e.Name()); err == nil {
			for _, f := range sub {
				if !f.IsDir() {
					add(f.Name(), filepath.Join(e.Name(), f.Name()))
				}
			}
		}
	}
	return out
}

func load(t *target) {
	img, err := core.OpenImage(t.path)
	if err != nil {
		t.openErr = err
		return
	}
	t.img = img
	t.results, t.patched, t.changed = core.PatchImage(img, t.game)
}

func showStatus(targets []target) {
	fmt.Println()
	for _, t := range targets {
		label := stName.Render(t.path)
		switch {
		case t.openErr != nil:
			fmt.Printf("  %s  %s\n", label, stErr.Render("cannot read: "+t.openErr.Error()))
		case blocking(t.results):
			fmt.Printf("  %s  %s\n", label, stWarn.Render("not supported on this version"))
		case t.changed:
			fmt.Printf("  %s  %s\n", label, stDim.Render("ready to patch"))
		default:
			fmt.Printf("  %s  %s\n", label, stOK.Render("already patched"))
		}
	}
}

func menu() string {
	choice := "patch"
	err := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("What do you want to do?").
			Options(
				huh.NewOption("Patch — enable achievements with mods", "patch"),
				huh.NewOption("Restore — undo, revert to original", "restore"),
				huh.NewOption("Quit", "quit"),
			).
			Value(&choice),
	)).Run()
	if err != nil {
		return "quit"
	}
	return choice
}

func doPatch(targets []target) {
	for _, t := range targets {
		name := stName.Render(t.path)
		if t.openErr != nil {
			fmt.Printf("  %s  %s\n", name, stErr.Render("skipped (cannot read)"))
			continue
		}
		for _, r := range t.results {
			if r.Status == core.StatusNoMatch || r.Status == core.StatusAmbig {
				fmt.Printf("  %s  %s\n", name, stWarn.Render(fmt.Sprintf("%s: %s", r.Site.ID, siteMsg(r))))
			}
		}
		if !t.changed {
			if blocking(t.results) {
				fmt.Printf("  %s  %s\n", name, stWarn.Render("not patched — version not supported (run the toolkit / file an issue)"))
			} else {
				fmt.Printf("  %s  %s\n", name, stOK.Render("already patched — nothing to do"))
			}
			continue
		}
		if _, stale, err := core.BackupIfAbsent(t.path, t.img.Raw); err != nil {
			fmt.Printf("  %s  %s\n", name, permErr("backup failed", err))
			continue
		} else if stale {
			fmt.Printf("  %s  %s\n", name, stWarn.Render("existing .backup is a different size (older version?) — kept it"))
		}
		if err := core.WritePatched(t.path, t.img.Raw, t.patched); err != nil {
			if errors.Is(err, core.ErrChangedOnDisk) {
				fmt.Printf("  %s  %s\n", name, stErr.Render("exe changed on disk mid-run — nothing written, re-run"))
			} else {
				fmt.Printf("  %s  %s\n", name, permErr("write failed", err))
			}
			continue
		}
		fmt.Printf("  %s  %s\n", name, stOK.Render("PATCHED ✓  achievements enabled (backup saved)"))
	}
	fmt.Println()
	fmt.Println(stOK.Render("Done.") + stDim.Render("  Launch the game — re-run this after every update. Undo: choose Restore."))
}

func doRestore(targets []target) {
	for _, t := range targets {
		name := stName.Render(t.path)
		if err := core.RestoreFromBackup(t.path); err != nil {
			fmt.Printf("  %s  %s\n", name, permErr("restore failed", err))
			continue
		}
		fmt.Printf("  %s  %s\n", name, stOK.Render("restored to original ✓"))
	}
}

// permErr renders a permission error with the actionable Windows fix.
func permErr(prefix string, err error) string {
	if errors.Is(err, os.ErrPermission) {
		return stErr.Render(prefix + ": permission denied — right-click this program and 'Run as administrator'")
	}
	return stErr.Render(prefix + ": " + err.Error())
}

func blocking(results []core.SiteResult) bool {
	for _, r := range results {
		if r.Status == core.StatusNoMatch || r.Status == core.StatusAmbig || r.Status == core.StatusError {
			return true
		}
	}
	return false
}

func siteMsg(r core.SiteResult) string {
	if r.Message != "" {
		return r.Message
	}
	return string(r.Status)
}

func gameNames(cfg *core.Config) []string {
	var names []string
	for n := range cfg.Games {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func pause(interactive bool) {
	if !interactive {
		return
	}
	fmt.Println()
	fmt.Print(stDim.Render("Press Enter to close..."))
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
