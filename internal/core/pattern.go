package core

import (
	"fmt"
	"strconv"
	"strings"
)

// Pattern is a byte pattern where -1 means wildcard ("??"), else a concrete 0..255.
type Pattern []int

// ParsePattern parses space-separated hex tokens; "??"/"?" become wildcards.
func ParsePattern(s string) (Pattern, error) {
	toks := strings.Fields(s)
	if len(toks) == 0 {
		return nil, fmt.Errorf("empty pattern")
	}
	p := make(Pattern, len(toks))
	for i, t := range toks {
		if t == "??" || t == "?" {
			p[i] = -1
			continue
		}
		v, err := strconv.ParseUint(t, 16, 8)
		if err != nil {
			return nil, fmt.Errorf("bad pattern token %q: %w", t, err)
		}
		p[i] = int(v)
	}
	return p, nil
}

// ParseBytes parses space-separated hex tokens into concrete bytes (no wildcards).
func ParseBytes(s string) ([]byte, error) {
	toks := strings.Fields(s)
	out := make([]byte, len(toks))
	for i, t := range toks {
		v, err := strconv.ParseUint(t, 16, 8)
		if err != nil {
			return nil, fmt.Errorf("bad byte token %q: %w", t, err)
		}
		out[i] = byte(v)
	}
	return out, nil
}

func (p Pattern) matchAt(data []byte, i int) bool {
	if i+len(p) > len(data) {
		return false
	}
	for k, b := range p {
		if b >= 0 && int(data[i+k]) != b {
			return false
		}
	}
	return true
}

func (p Pattern) FindAll(data []byte) []int {
	var out []int
	for i := 0; i+len(p) <= len(data); i++ {
		if p.matchAt(data, i) {
			out = append(out, i)
		}
	}
	return out
}

// Overlay returns a copy of the pattern with concrete bytes written at off — used
// to derive the "already patched" pattern (Find with Replace applied).
func (p Pattern) Overlay(off int, repl []byte) Pattern {
	q := make(Pattern, len(p))
	copy(q, p)
	for i, b := range repl {
		if off+i < len(q) {
			q[off+i] = int(b)
		}
	}
	return q
}
