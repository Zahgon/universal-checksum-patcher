// Package core is the shared engine for the patcher and toolkit: PE parsing,
// wildcard byte matching, string-anchored search, and safe on-disk patching.
package core

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"fmt"
	"os"
	"sort"
)

// Image is a parsed PE plus its full file bytes, so file offsets index into Raw.
type Image struct {
	Path     string
	Raw      []byte // full file bytes; kept pristine
	Base     uint64 // ImageBase
	PtrSize  int    // 8 (x64) or 4 (x86)
	Machine  uint16
	Sections []*Section
	pdata    []FnRange // sorted by Begin; empty on x86
}

type Section struct {
	Name    string
	RVA     uint32 // VirtualAddress
	VSize   uint32 // VirtualSize
	FileOff uint32 // PointerToRawData
	RawSize uint32 // SizeOfRawData
}

// FnRange is a .pdata runtime-function [Begin,End) in RVA space.
type FnRange struct{ Begin, End uint32 }

// OpenImage reads and parses a PE file.
func OpenImage(path string) (*Image, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	f, err := pe.NewFile(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("parse PE %s: %w", path, err)
	}
	defer f.Close()

	img := &Image{Path: path, Raw: raw, Machine: f.Machine}
	switch oh := f.OptionalHeader.(type) {
	case *pe.OptionalHeader64:
		img.Base, img.PtrSize = oh.ImageBase, 8
	case *pe.OptionalHeader32:
		img.Base, img.PtrSize = uint64(oh.ImageBase), 4
	default:
		return nil, fmt.Errorf("%s: unrecognised optional header", path)
	}

	for _, ps := range f.Sections {
		img.Sections = append(img.Sections, &Section{
			Name: ps.Name, RVA: ps.VirtualAddress, VSize: ps.VirtualSize,
			FileOff: ps.Offset, RawSize: ps.Size,
		})
	}
	if pd := f.Section(".pdata"); pd != nil {
		d, _ := pd.Data()
		for off := 0; off+12 <= len(d); off += 12 {
			begin := binary.LittleEndian.Uint32(d[off:])
			end := binary.LittleEndian.Uint32(d[off+4:])
			if begin < end { // drop null/degenerate entries
				img.pdata = append(img.pdata, FnRange{begin, end})
			}
		}
		sort.Slice(img.pdata, func(i, j int) bool { return img.pdata[i].Begin < img.pdata[j].Begin })
	}
	return img, nil
}

// IsX64 reports whether the image is 64-bit (RIP-relative addressing).
func (img *Image) IsX64() bool { return img.PtrSize == 8 }

func (img *Image) section(name string) *Section {
	for _, s := range img.Sections {
		if s.Name == name {
			return s
		}
	}
	return nil
}

// Text returns the .text section (nil if absent).
func (img *Image) Text() *Section { return img.section(".text") }

// Bytes returns a section's raw bytes (subslice of Raw), or nil if the section
// header points outside the file (truncated/corrupt PE).
func (img *Image) Bytes(s *Section) []byte {
	if int(s.FileOff) > len(img.Raw) {
		return nil
	}
	end := int(s.FileOff) + int(s.RawSize)
	if end > len(img.Raw) {
		end = len(img.Raw)
	}
	return img.Raw[s.FileOff:end]
}

// sectionForRVA finds the section whose virtual range contains rva.
func (img *Image) sectionForRVA(rva uint32) *Section {
	for _, s := range img.Sections {
		if rva >= s.RVA && rva < s.RVA+s.VSize {
			return s
		}
	}
	return nil
}

// RVAToFileOff maps an RVA to a file offset (false if not in a raw-backed section).
func (img *Image) RVAToFileOff(rva uint32) (int, bool) {
	s := img.sectionForRVA(rva)
	if s == nil {
		return 0, false
	}
	off := int(rva-s.RVA) + int(s.FileOff)
	if off < 0 || off >= len(img.Raw) {
		return 0, false
	}
	return off, true
}

// FuncContains returns the .pdata function range containing rva.
func (img *Image) FuncContains(rva uint32) (FnRange, bool) {
	i := sort.Search(len(img.pdata), func(i int) bool { return img.pdata[i].End > rva })
	if i < len(img.pdata) && rva >= img.pdata[i].Begin && rva < img.pdata[i].End {
		return img.pdata[i], true
	}
	return FnRange{}, false
}

// stringVAs returns the VAs of every occurrence of s that begins a null-terminated
// string — i.e. s is a prefix at a string boundary. Not requiring a trailing null
// lets an anchor like "Active Mod Count:" match the literal "Active Mod Count: ".
func (img *Image) stringVAs(s string) []uint64 {
	needle := []byte(s)
	var out []uint64
	for _, sec := range img.Sections {
		data := img.Bytes(sec)
		for i := 0; ; {
			j := bytes.Index(data[i:], needle)
			if j < 0 {
				break
			}
			at := i + j
			if at == 0 || data[at-1] == 0 { // preceded by a string boundary
				out = append(out, img.Base+uint64(sec.RVA)+uint64(at))
			}
			i = at + 1
		}
	}
	return out
}

// leaXrefRVAs finds `lea r64,[rip+disp32]` sites in .text whose target == targetVA.
// x64 only. Exact target-VA match filters coincidental mid-instruction hits.
func (img *Image) leaXrefRVAs(targetVA uint64) []uint32 {
	text := img.Text()
	if text == nil || !img.IsX64() {
		return nil
	}
	d := img.Bytes(text)
	var out []uint32
	for i := 0; i+7 <= len(d); i++ {
		if b := d[i]; b != 0x48 && b != 0x49 && b != 0x4C && b != 0x4D {
			continue
		}
		if d[i+1] != 0x8D || d[i+2]&0xC7 != 0x05 {
			continue
		}
		disp := int32(binary.LittleEndian.Uint32(d[i+3:]))
		targetRVA := int64(text.RVA) + int64(i) + 7 + int64(disp)
		if img.Base+uint64(targetRVA) == targetVA {
			out = append(out, text.RVA+uint32(i))
		}
	}
	return out
}

// FuncsReferencingString returns distinct .pdata function ranges that load the
// address of the given string — the string-anchor used to restrict a search.
func (img *Image) FuncsReferencingString(anchor string) []FnRange {
	seen := map[FnRange]bool{}
	var out []FnRange
	for _, va := range img.stringVAs(anchor) {
		for _, site := range img.leaXrefRVAs(va) {
			if fr, in := img.FuncContains(site); in && !seen[fr] {
				seen[fr] = true
				out = append(out, fr)
			}
		}
	}
	return out
}
