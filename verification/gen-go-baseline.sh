#!/usr/bin/env bash
# Regenerates the Go ground-truth baseline from upstream source.
#
# The Go repository is the sole authority on behaviour, so the baseline is
# re-derived rather than trusted from a checked-in file. Requires a Go toolchain.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${UCP_GO_REPO:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ -z "$REPO" ]]; then
  echo "Cloning upstream godotenv-style source..."
  git clone --quiet --depth 1 \
    https://github.com/IlliaYalovoi/universal-checksum-patcher "$WORK/src"
  REPO="$WORK/src"
fi

cp -R "$REPO" "$WORK/go"
cp "$HERE/go-driver.go.txt" "$WORK/go/internal/core/zz_driver_test.go"
cp "$HERE/go-fuzz-driver.go.txt" "$WORK/go/internal/core/zz_fuzz_test.go"

pushd "$WORK/go" >/dev/null

# The driver reads ../../build/toolkit.exe as its real-PE corpus.
GOOS=windows GOARCH=amd64 go build -o build/toolkit.exe ./cmd/toolkit
GOOS=windows GOARCH=amd64 go build -o build/universal-checksum-patcher.exe ./cmd/patcher

# The upstream suite must be green before its output is used as a baseline.
go test ./...

UCP_TRUTH_OUT="${UCP_TRUTH_OUT:-/tmp/go-truth.json}" \
  go test -run TestZZDumpGroundTruth ./internal/core/ -v

# Malformed-PE corpus plus Go's OpenImage outcome for each case.
rm -rf "${UCP_FUZZ_DIR:-/tmp/ucpfuzz}"
UCP_FUZZ_DIR="${UCP_FUZZ_DIR:-/tmp/ucpfuzz}/cases" \
  go test -run TestZZFuzzCorpus ./internal/core/ -v

# Native binaries for the CLI differential harness.
go build -o /tmp/gopatcher ./cmd/patcher
go build -o /tmp/gotoolkit ./cmd/toolkit

popd >/dev/null

# The corpus and the baseline describe each other: every recorded PE value is
# derived from this exact binary, and Go embeds the build path so a rebuild is a
# different file. Refresh them together or `npm test` fails on a pair that has
# silently drifted apart.
cp "$WORK/go/build/toolkit.exe" "$HERE/corpus/toolkit.exe"
cp "${UCP_TRUTH_OUT:-/tmp/go-truth.json}" "$HERE/go-baseline.json"

echo "Baseline written to ${UCP_TRUTH_OUT:-/tmp/go-truth.json}"
echo "Committed pair refreshed: verification/corpus/toolkit.exe + verification/go-baseline.json"
