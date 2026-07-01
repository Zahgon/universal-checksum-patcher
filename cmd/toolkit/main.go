// Command toolkit is the maintainer's discovery tool. When a game update breaks a
// signature, point it at the new exe: it finds the checksum/achievement gate by
// shape + the strings its function references, and prints a ready-to-paste recipe.
//
// Usage:
//
//	toolkit discover <exe>              find + label candidate gates, suggest a recipe
//	toolkit match    <exe> "<pattern>" count/locate a wildcard pattern (?? = any byte)
//	toolkit anchor   <exe> <string>    show functions that reference a string
//	toolkit dump     <exe> <rva> <len> hex-dump bytes at an RVA
package main

import (
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/IlliaYalovoi/universal-checksum-patcher/internal/core"
)

// keywords that make a checksum/achievement/ironman gate self-identify.
var gateKeywords = []string{"chievement", "ronman", "hecksum", "mod count", "andatory", "gameapplication", "application.cpp", "dlc count"}

func main() {
	if len(os.Args) < 3 {
		usage()
		os.Exit(2)
	}
	cmd, exe := os.Args[1], os.Args[2]
	img, err := core.OpenImage(exe)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("%s  ImageBase 0x%X  x64=%v\n\n", exe, img.Base, img.IsX64())

	switch cmd {
	case "discover":
		discover(img)
	case "match":
		if len(os.Args) < 4 {
			usage()
			os.Exit(2)
		}
		matchCmd(img, strings.Join(os.Args[3:], " "))
	case "anchor":
		if len(os.Args) < 4 {
			usage()
			os.Exit(2)
		}
		anchorCmd(img, os.Args[3])
	case "dump":
		if len(os.Args) < 5 {
			usage()
			os.Exit(2)
		}
		dumpCmd(img, os.Args[3], os.Args[4])
	default:
		usage()
		os.Exit(2)
	}
}

func discover(img *core.Image) {
	cands := img.FindGates(gateKeywords)
	// Rank so the real checksum gate floats above the achievement-UI hits.
	sort.SliceStable(cands, func(a, b int) bool { return score(cands[a].Strings) > score(cands[b].Strings) })

	fmt.Printf("gate candidates: %d (showing top %d by relevance)\n\n", len(cands), min(len(cands), 6))
	for i, c := range cands {
		if i >= 6 {
			break
		}
		fmt.Printf("[%d] score %d  RVA 0x%X  gate %s  func[0x%X..0x%X]\n", i+1, score(c.Strings), c.RVA, hexBytes(c.Bytes), c.Func.Begin, c.Func.End)
		fmt.Printf("    strings: %s\n", strings.Join(trim(c.Strings, 6), " | "))
		if i == 0 {
			fmt.Printf("    suggested recipe (verify with `toolkit match`):\n%s\n", suggestRecipe(c))
		}
		fmt.Println()
	}
	if len(cands) == 0 {
		fmt.Println("No test;setcc gate matched the keyword filter.")
		fmt.Println("The gate may be a different shape (e.g. EU5's cmp-byte-flag chain).")
		fmt.Println("Use `toolkit match <exe> \"<pattern>\"` to test a candidate pattern,")
		fmt.Println("or `toolkit anchor <exe> CanGetAchievements` to locate a named gate.")
	}
}

// score weights a function's strings toward the specific checksum gate: the killer
// combo is a version/mod dump ("Active Mod Count" + an MD5 hash). Generic
// checksum/achievement/ironman strings appear everywhere, so they weigh little.
func score(strs []string) int {
	blob := strings.ToLower(strings.Join(strs, "\x00"))
	s := 0
	for kw, w := range map[string]int{
		"mod count": 10, "dlc count": 4,
		"gameapplication": 3, "eu4application": 3, "session.cpp": 3, "synchronizationmanager": 3,
		"checksum": 2, "chievement": 1, "ronman": 1,
	} {
		if strings.Contains(blob, kw) {
			s += w
		}
	}
	for _, str := range strs {
		if isMD5(str) {
			s += 8
			break
		}
	}
	return s
}

func isMD5(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func matchCmd(img *core.Image, pattern string) {
	p, err := core.ParsePattern(pattern)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	rvas := img.MatchInText(p)
	fmt.Printf("pattern %q -> %d match(es)\n", pattern, len(rvas))
	for i, rva := range rvas {
		if i >= 25 {
			fmt.Printf("  ... %d more\n", len(rvas)-25)
			break
		}
		label := "(not in a .pdata function)"
		if fr, in := img.FuncContains(rva); in {
			label = fmt.Sprintf("func[0x%X..0x%X] strings=%s", fr.Begin, fr.End, strings.Join(trim(img.StringsInFunc(fr), 5), " | "))
		}
		fmt.Printf("  RVA 0x%X  %s\n", rva, label)
	}
}

func anchorCmd(img *core.Image, s string) {
	frs := img.FuncsReferencingString(s)
	fmt.Printf("functions referencing %q: %d\n", s, len(frs))
	for _, fr := range frs {
		fmt.Printf("  func[0x%X..0x%X]  strings=%s\n", fr.Begin, fr.End, strings.Join(trim(img.StringsInFunc(fr), 6), " | "))
	}
}

func dumpCmd(img *core.Image, rvaStr, lenStr string) {
	rva64, err1 := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(rvaStr), "0x"), 16, 64)
	n64, err2 := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(lenStr), "0x"), 16, 64)
	if err1 != nil || err2 != nil {
		fmt.Fprintln(os.Stderr, "rva and len must be hex, e.g. 0x16ECD0 0x40")
		os.Exit(1)
	}
	if rva64 > math.MaxUint32 {
		fmt.Fprintln(os.Stderr, "rva out of range")
		os.Exit(1)
	}
	if n64 > 1<<20 {
		n64 = 1 << 20 // cap dump at 1 MiB
	}
	off, ok := img.RVAToFileOff(uint32(rva64))
	if !ok {
		fmt.Fprintln(os.Stderr, "RVA not in a raw-backed section")
		os.Exit(1)
	}
	for row := 0; row < int(n64); row += 16 {
		fmt.Printf("  0x%X: ", uint32(rva64)+uint32(row))
		for col := 0; col < 16 && row+col < int(n64) && off+row+col < len(img.Raw); col++ {
			fmt.Printf("%02X ", img.Raw[off+row+col])
		}
		fmt.Println()
	}
}

// suggestRecipe emits a paste-ready signatures.json site for a test;setcc gate,
// anchored to the most gate-like string in the function.
func suggestRecipe(c core.GateCandidate) string {
	anchor := pickAnchor(c.Strings)
	anchorLine := ""
	if anchor != "" {
		anchorLine = fmt.Sprintf("      \"anchor\": %q,\n", anchor)
	}
	return fmt.Sprintf(`    {
      "id": "checksum_gate",
%s      "find": "85 C0 0F 94 ?? E8",
      "patchOffset": 0,
      "expect": "85 C0",
      "replace": "31 C0",
      "requireInFunc": true,
      "expectMatches": 1
    }`, anchorLine)
}

func pickAnchor(strs []string) string {
	for _, k := range gateKeywords {
		for _, s := range strs {
			if strings.Contains(strings.ToLower(s), k) && !strings.Contains(s, `\`) && len(s) < 40 {
				return s
			}
		}
	}
	return ""
}

func hexBytes(b []byte) string {
	parts := make([]string, len(b))
	for i, x := range b {
		parts[i] = fmt.Sprintf("%02X", x)
	}
	return strings.Join(parts, " ")
}

func trim(s []string, n int) []string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func usage() {
	fmt.Fprintln(os.Stderr, `toolkit — maintainer discovery tool
  toolkit discover <exe>              find + label candidate gates, suggest a recipe
  toolkit match    <exe> "<pattern>" count/locate a wildcard pattern (?? = any byte)
  toolkit anchor   <exe> <string>    show functions referencing a string
  toolkit dump     <exe> <rva> <len> hex-dump bytes at an RVA (hex args)`)
}
