package core

import (
	"encoding/binary"
	"strings"
)

// GateCandidate is a location that looks like a checksum/achievement gate, with
// enough context (containing function + the strings it references) to identify it.
type GateCandidate struct {
	RVA     uint32
	Func    FnRange
	Bytes   []byte   // the matched gate bytes
	Strings []string // strings referenced by the containing function
}

// FindGates scans .text for the gate shape `test al/eax,self ; setz/setnz r8`
// (`(84|85) C0 0F (94|95) ??`) and returns each hit inside a .pdata function,
// labelled with the strings that function references. If keywords is non-empty, only
// candidates referencing one (case-insensitive) are returned — how the gate
// self-identifies (e.g. "Active Mod Count").
func (img *Image) FindGates(keywords []string) []GateCandidate {
	text := img.Text()
	if text == nil {
		return nil
	}
	d := img.Bytes(text)
	strCache := map[FnRange][]string{} // one StringsInFunc scan per function
	var out []GateCandidate
	for i := 0; i+5 <= len(d); i++ {
		if (d[i] == 0x84 || d[i] == 0x85) && d[i+1] == 0xC0 && d[i+2] == 0x0F &&
			(d[i+3] == 0x94 || d[i+3] == 0x95) {
			rva := text.RVA + uint32(i)
			fr, in := img.FuncContains(rva)
			if !in {
				continue
			}
			strs, ok := strCache[fr]
			if !ok {
				strs = img.StringsInFunc(fr)
				strCache[fr] = strs
			}
			if len(keywords) > 0 && !anyKeyword(strs, keywords) {
				continue
			}
			out = append(out, GateCandidate{RVA: rva, Func: fr, Bytes: append([]byte(nil), d[i:i+6]...), Strings: strs})
		}
	}
	return out
}

// MatchInText returns the RVAs of every place the pattern matches in .text.
func (img *Image) MatchInText(p Pattern) []uint32 {
	text := img.Text()
	if text == nil {
		return nil
	}
	var out []uint32
	for _, off := range p.FindAll(img.Bytes(text)) {
		out = append(out, text.RVA+uint32(off))
	}
	return out
}

// StringsInFunc returns distinct printable strings referenced by `lea r64,[rip]`
// inside a function.
func (img *Image) StringsInFunc(fr FnRange) []string {
	text := img.Text()
	if text == nil {
		return nil
	}
	d := img.Bytes(text)
	start, end := int(fr.Begin)-int(text.RVA), int(fr.End)-int(text.RVA)
	if start < 0 || end > len(d) || start >= end {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for i := start; i+7 <= end; i++ {
		if (d[i] == 0x48 || d[i] == 0x4C) && d[i+1] == 0x8D && d[i+2]&0xC7 == 0x05 {
			disp := int32(binary.LittleEndian.Uint32(d[i+3:]))
			va := img.Base + uint64(int64(text.RVA)+int64(i)+7+int64(disp))
			if s := img.cStringAt(va); len(s) >= 4 && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out
}

// cStringAt reads a printable, null-terminated ASCII string at a VA (any section).
func (img *Image) cStringAt(va uint64) string {
	if va < img.Base {
		return ""
	}
	s := img.sectionForRVA(uint32(va - img.Base))
	if s == nil {
		return ""
	}
	data := img.Bytes(s)
	off := int(uint32(va-img.Base) - s.RVA)
	if off < 0 || off >= len(data) {
		return ""
	}
	end := off
	for end < len(data) && data[end] != 0 && end-off < 96 {
		if c := data[end]; c < 0x20 || c > 0x7E {
			return ""
		}
		end++
	}
	return string(data[off:end])
}

func anyKeyword(strs, keywords []string) bool {
	blob := strings.ToLower(strings.Join(strs, "\x00"))
	for _, k := range keywords {
		if strings.Contains(blob, strings.ToLower(k)) {
			return true
		}
	}
	return false
}
