package core

import "testing"

func TestParsePattern(t *testing.T) {
	p, err := ParsePattern("85 C0 ?? 0F")
	if err != nil {
		t.Fatal(err)
	}
	want := Pattern{0x85, 0xC0, -1, 0x0F}
	if len(p) != len(want) {
		t.Fatalf("len %d != %d", len(p), len(want))
	}
	for i := range want {
		if p[i] != want[i] {
			t.Fatalf("byte %d: %d != %d", i, p[i], want[i])
		}
	}
	if _, err := ParsePattern("85 ZZ"); err == nil {
		t.Fatal("expected error on bad token")
	}
	if _, err := ParsePattern(""); err == nil {
		t.Fatal("expected error on empty pattern")
	}
}

func TestFindAllWildcards(t *testing.T) {
	data := []byte{0x00, 0x85, 0xC0, 0x11, 0x0F, 0x85, 0xC0, 0x22, 0x0F, 0x90}
	p, _ := ParsePattern("85 C0 ?? 0F")
	got := p.FindAll(data)
	if len(got) != 2 || got[0] != 1 || got[1] != 5 {
		t.Fatalf("FindAll = %v, want [1 5]", got)
	}
}

func TestOverlay(t *testing.T) {
	p, _ := ParsePattern("85 C0 0F 94 ?? E8")
	q := p.Overlay(0, []byte{0x31, 0xC0})
	if q[0] != 0x31 || q[1] != 0xC0 || q[4] != -1 {
		t.Fatalf("overlay wrong: %v", q)
	}
	if p[0] != 0x85 {
		t.Fatal("Overlay mutated original pattern")
	}
}

func TestLoadConfigEmbedded(t *testing.T) {
	cfg, src, err := LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if src != "embedded" {
		t.Fatalf("src = %q", src)
	}
	for _, name := range []string{"hoi4.exe", "eu4.exe", "eu5.exe"} {
		g, ok := cfg.Games[name]
		if !ok || len(g.Sites) == 0 {
			t.Fatalf("game %s missing or has no sites", name)
		}
		for _, s := range g.Sites {
			if _, err := ParsePattern(s.Find); err != nil {
				t.Errorf("%s/%s: bad find pattern: %v", name, s.ID, err)
			}
			if _, err := ParseBytes(s.Expect); err != nil {
				t.Errorf("%s/%s: bad expect: %v", name, s.ID, err)
			}
			if _, err := ParseBytes(s.Replace); err != nil {
				t.Errorf("%s/%s: bad replace: %v", name, s.ID, err)
			}
		}
	}
}

// synthImage builds a minimal in-memory x64 image with a single .text section and
// one .pdata function spanning it, so applySite can be exercised without a real PE.
func synthImage(text []byte) *Image {
	const textRVA, textFileOff = 0x1000, 0x200
	raw := make([]byte, textFileOff+len(text)+16)
	copy(raw[textFileOff:], text)
	return &Image{
		Raw: raw, Base: 0x140000000, PtrSize: 8,
		Sections: []*Section{{Name: ".text", RVA: textRVA, VSize: uint32(len(text)), FileOff: textFileOff, RawSize: uint32(len(text))}},
		pdata:    []FnRange{{Begin: textRVA, End: textRVA + uint32(len(text))}},
	}
}

func gateSite() Site {
	return Site{ID: "g", Find: "85 C0 0F 94 ?? E8", PatchOffset: 0, Expect: "85 C0", Replace: "31 C0", RequireInFunc: true, ExpectMatches: 1}
}

func TestApplySitePatchAndIdempotent(t *testing.T) {
	img := synthImage([]byte{0x90, 0x85, 0xC0, 0x0F, 0x94, 0xC3, 0xE8, 0x11, 0x22, 0x33})
	r := applySite(img, img.Raw, gateSite())
	if r.Status != StatusPatched || len(r.RVAs) != 1 {
		t.Fatalf("status %s rvas %v", r.Status, r.RVAs)
	}
	if img.Raw[0x200+1] != 0x31 || img.Raw[0x200+2] != 0xC0 {
		t.Fatalf("bytes not patched: %02X %02X", img.Raw[0x201], img.Raw[0x202])
	}
	// Re-running on the patched image reports already-patched, no error.
	if r2 := applySite(img, img.Raw, gateSite()); r2.Status != StatusAlready {
		t.Fatalf("re-run status = %s, want already-patched", r2.Status)
	}
}

func TestApplySiteNotFound(t *testing.T) {
	img := synthImage([]byte{0x90, 0x90, 0x90, 0x90})
	if r := applySite(img, img.Raw, gateSite()); r.Status != StatusNoMatch {
		t.Fatalf("status = %s, want not-found", r.Status)
	}
}

func TestApplySiteAmbiguousRefuses(t *testing.T) {
	// Two gates but ExpectMatches defaults to 1 -> refuse, and Raw must be untouched.
	img := synthImage([]byte{0x85, 0xC0, 0x0F, 0x94, 0xC3, 0xE8, 0x00, 0x85, 0xC0, 0x0F, 0x94, 0xC1, 0xE8, 0x00})
	before := append([]byte(nil), img.Raw...)
	s := gateSite()
	s.ExpectMatches = 1
	r := applySite(img, img.Raw, s)
	if r.Status != StatusAmbig {
		t.Fatalf("status = %s, want ambiguous", r.Status)
	}
	if !bytesEqual(img.Raw, before) {
		t.Fatal("ambiguous match must not modify the image")
	}
}

func TestApplySiteExpectMismatch(t *testing.T) {
	img := synthImage([]byte{0x90, 0x85, 0xC0, 0x0F, 0x94, 0xC3, 0xE8})
	s := gateSite()
	s.Expect = "99 99" // wrong expected bytes at the match
	if r := applySite(img, img.Raw, s); r.Status != StatusError {
		t.Fatalf("status = %s, want error", r.Status)
	}
}

func TestPatchImageTransactionalDiscardsOnBlock(t *testing.T) {
	// One good gate + one site that is ambiguous (0x90 occurs twice, want 1).
	// PatchImage must discard everything (nil bytes, changed=false) — no half-write.
	img2 := synthImage([]byte{0x90, 0x85, 0xC0, 0x0F, 0x94, 0xC3, 0xE8, 0x90})
	good := gateSite()
	bad := Site{ID: "bad", Find: "90", PatchOffset: 0, Expect: "90", Replace: "CC", ExpectMatches: 1}
	results, patched, changed := PatchImage(img2, Game{Sites: []Site{good, bad}})
	if changed || patched != nil {
		t.Fatalf("expected transactional discard: changed=%v patchedNil=%v", changed, patched == nil)
	}
	sawAmbig := false
	for _, r := range results {
		if r.Status == StatusAmbig {
			sawAmbig = true
		}
	}
	if !sawAmbig {
		t.Fatal("expected an ambiguous site")
	}
	// img2.Raw must be pristine (untouched).
	if img2.Raw[0x200+1] != 0x85 {
		t.Fatal("PatchImage mutated img.Raw despite blocking")
	}
}

func TestPatchImageBlocksOnNotFound(t *testing.T) {
	// Site A patches, site B is not-found. PatchImage must discard everything
	// (no partial write) because a required site failed.
	img := synthImage([]byte{0x90, 0x85, 0xC0, 0x0F, 0x94, 0xC3, 0xE8, 0x11})
	good := gateSite()
	missing := Site{ID: "missing", Find: "DE AD BE EF", PatchOffset: 0, Expect: "DE", Replace: "FF", ExpectMatches: 1}
	_, patched, changed := PatchImage(img, Game{Sites: []Site{good, missing}})
	if changed || patched != nil {
		t.Fatalf("expected discard on not-found site: changed=%v patchedNil=%v", changed, patched == nil)
	}
	if img.Raw[0x201] != 0x85 {
		t.Fatal("img.Raw mutated despite a blocking not-found site")
	}
}

func TestApplySiteRequireInFuncFiltersOutOfFunc(t *testing.T) {
	// Gate present but no .pdata function covers it -> filtered out -> not found.
	img := synthImage([]byte{0x90, 0x85, 0xC0, 0x0F, 0x94, 0xC3, 0xE8})
	img.pdata = nil
	if r := applySite(img, img.Raw, gateSite()); r.Status != StatusNoMatch {
		t.Fatalf("status = %s, want not-found (filtered)", r.Status)
	}
}
