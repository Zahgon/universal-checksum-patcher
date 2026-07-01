package core

import "fmt"

type Config struct {
	Games map[string]Game `json:"games"`
}

type Game struct {
	Sites []Site `json:"sites"`
}

// Site is one patch recipe: locate Find (wildcards allowed), verify Expect at
// PatchOffset, write Replace. Optionally restrict to functions referencing Anchor
// and/or require the match to sit inside a real .pdata function.
type Site struct {
	ID            string `json:"id"`
	Anchor        string `json:"anchor,omitempty"`        // restrict search to funcs referencing this string
	Find          string `json:"find"`                    // wildcard byte pattern
	PatchOffset   int    `json:"patchOffset"`             // offset within a match to write Replace
	Expect        string `json:"expect"`                  // bytes that must be present before patching
	Replace       string `json:"replace"`                 // bytes to write (same length as Expect)
	RequireInFunc bool   `json:"requireInFunc,omitempty"` // match must be inside a .pdata function
	ExpectMatches int    `json:"expectMatches,omitempty"` // required match count (default 1); fail-closed otherwise
	Note          string `json:"note,omitempty"`
}

type Status string

const (
	StatusPatched Status = "patched"
	StatusAlready Status = "already-patched"
	StatusNoMatch Status = "not-found"
	StatusAmbig   Status = "ambiguous" // match count != expected; refused
	StatusError   Status = "error"
)

type SiteResult struct {
	Site    Site
	Status  Status
	Count   int      // matches of the unpatched pattern
	RVAs    []uint32 // patched locations
	Message string
}

// PatchImage applies every site into a clone of img.Raw. Transactional: if any site
// blocks (not-found/ambiguous/error) the clone is discarded and (results, nil, false)
// is returned, so a caller never writes a half-patched exe. img.Raw stays pristine.
func PatchImage(img *Image, game Game) ([]SiteResult, []byte, bool) {
	out := append([]byte(nil), img.Raw...)
	var results []SiteResult
	blocking, anyPatched := false, false
	for _, site := range game.Sites {
		r := applySite(img, out, site)
		switch r.Status {
		case StatusPatched:
			anyPatched = true
		case StatusAlready:
			// not a change, not a blocker
		default: // not-found/ambiguous/error: a required site failed, block the game
			blocking = true
		}
		results = append(results, r)
	}
	if blocking || !anyPatched {
		return results, nil, false
	}
	return results, out, true
}

// applySite locates the site's matches in img (pristine), and writes replacements
// into out (a same-length buffer, typically a clone of img.Raw). It never writes
// unless every match is bounds- and expect-verified first (two-phase).
func applySite(img *Image, out []byte, site Site) SiteResult {
	res := SiteResult{Site: site}
	want := site.ExpectMatches
	if want == 0 {
		want = 1
	}

	find, err := ParsePattern(site.Find)
	if err != nil {
		return res.err(err.Error())
	}
	expect, err := ParseBytes(site.Expect)
	if err != nil {
		return res.err("expect: " + err.Error())
	}
	replace, err := ParseBytes(site.Replace)
	if err != nil {
		return res.err("replace: " + err.Error())
	}
	if err := validateSite(site, find, expect, replace); err != nil {
		return res.err(err.Error())
	}

	text := img.Text()
	if text == nil {
		return res.err("no .text section")
	}
	tbytes := img.Bytes(text)
	if tbytes == nil {
		return res.err("unreadable .text section")
	}

	// Optional string-anchor: restrict to functions that reference the anchor.
	var anchorRanges []FnRange
	if site.Anchor != "" {
		anchorRanges = img.FuncsReferencingString(site.Anchor)
		if len(anchorRanges) == 0 {
			res.Status = StatusNoMatch
			res.Message = fmt.Sprintf("anchor %q not referenced in code", site.Anchor)
			return res
		}
	}

	keep := func(rva uint32) bool {
		if site.RequireInFunc || len(anchorRanges) > 0 {
			fr, in := img.FuncContains(rva)
			if !in {
				return false
			}
			if len(anchorRanges) > 0 && !containsRange(anchorRanges, fr) {
				return false
			}
		}
		return true
	}
	filter := func(offsets []int) []uint32 {
		var out []uint32
		for _, off := range offsets {
			rva := text.RVA + uint32(off)
			if keep(rva) {
				out = append(out, rva)
			}
		}
		return out
	}

	matches := filter(find.FindAll(tbytes))
	res.Count = len(matches)

	if len(matches) == 0 {
		// Distinguish already-patched from genuinely missing. Require the patched
		// pattern to appear exactly `want` times, else it's an odd/partial state.
		patched := filter(find.Overlay(site.PatchOffset, replace).FindAll(tbytes))
		switch {
		case len(patched) == want:
			res.Status = StatusAlready
		case len(patched) > 0:
			res.Status = StatusAmbig
			res.Message = fmt.Sprintf("found %d patched matches, expected %d (partial/foreign patch?)", len(patched), want)
		default:
			res.Status = StatusNoMatch
		}
		return res
	}
	if len(matches) != want {
		res.Status = StatusAmbig
		res.Message = fmt.Sprintf("found %d matches, expected %d", len(matches), want)
		return res
	}

	// Phase 1: resolve + verify every write before touching any bytes.
	type write struct {
		off int
		rva uint32
	}
	var writes []write
	for _, rva := range matches {
		off, ok := img.RVAToFileOff(rva + uint32(site.PatchOffset))
		if !ok || off+len(replace) > len(out) || off+len(expect) > len(img.Raw) {
			return res.err(fmt.Sprintf("write range out of bounds at RVA 0x%X", rva+uint32(site.PatchOffset)))
		}
		if !bytesEqual(img.Raw[off:off+len(expect)], expect) {
			return res.err(fmt.Sprintf("expect bytes mismatch at RVA 0x%X", rva+uint32(site.PatchOffset)))
		}
		writes = append(writes, write{off, rva})
	}
	// Phase 2: commit.
	for _, w := range writes {
		copy(out[w.off:w.off+len(replace)], replace)
		res.RVAs = append(res.RVAs, w.rva)
	}
	res.Status = StatusPatched
	return res
}

// validateSite rejects recipes whose patch would fall outside the located match —
// the main safeguard for untrusted override configs.
func validateSite(site Site, find Pattern, expect, replace []byte) error {
	if len(expect) == 0 || len(replace) == 0 {
		return fmt.Errorf("site %s: empty expect/replace", site.ID)
	}
	if len(expect) != len(replace) {
		return fmt.Errorf("site %s: expect (%d) and replace (%d) must be the same length", site.ID, len(expect), len(replace))
	}
	if site.PatchOffset < 0 || site.PatchOffset+len(expect) > len(find) {
		return fmt.Errorf("site %s: patchOffset+expect exceeds find pattern length", site.ID)
	}
	// The find pattern's concrete bytes at the patch offset must equal expect.
	for i := range expect {
		if b := find[site.PatchOffset+i]; b >= 0 && byte(b) != expect[i] {
			return fmt.Errorf("site %s: expect byte %d disagrees with find pattern", site.ID, i)
		}
	}
	return nil
}

func (r SiteResult) err(msg string) SiteResult {
	r.Status, r.Message = StatusError, msg
	return r
}

func containsRange(rs []FnRange, r FnRange) bool {
	for _, x := range rs {
		if x == r {
			return true
		}
	}
	return false
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
