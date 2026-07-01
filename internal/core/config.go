package core

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
)

//go:embed signatures.json
var defaultSignatures []byte

// LoadConfig returns the signature database. If a file exists at overridePath
// (e.g. ./signatures.json next to the exe) it is used instead of the embedded
// default, so a game can be fixed by shipping a config, not a new binary.
func LoadConfig(overridePath string) (*Config, string, error) {
	src := "embedded"
	raw := defaultSignatures
	if overridePath != "" {
		if data, err := os.ReadFile(overridePath); err == nil {
			raw, src = data, overridePath
		} else if !os.IsNotExist(err) {
			return nil, "", fmt.Errorf("read override %s: %w", overridePath, err)
		}
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, src, fmt.Errorf("parse signatures (%s): %w", src, err)
	}
	return &cfg, src, nil
}
