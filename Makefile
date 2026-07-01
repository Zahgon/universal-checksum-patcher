BIN     := build
PATCHER := $(BIN)/universal-checksum-patcher.exe
TOOLKIT := $(BIN)/toolkit.exe

.PHONY: all test patcher toolkit build clean

all: test build

test:
	@go test ./...

build: patcher toolkit

patcher:
	@GOOS=windows GOARCH=amd64 go build -o $(PATCHER) ./cmd/patcher
	@echo Built $(PATCHER)

toolkit:
	@GOOS=windows GOARCH=amd64 go build -o $(TOOLKIT) ./cmd/toolkit
	@echo Built $(TOOLKIT)

clean:
	@rm -rf $(BIN)
