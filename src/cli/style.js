// The lipgloss subset this program uses: bold, 256-colour fg/bg, horizontal
// padding, and colour degradation when the output is not a terminal.
//
// Verified against the Go binary: with a non-TTY stdout lipgloss emits no SGR
// at all but still applies padding, so piped output is plain text. Padding cells
// are emitted as their own background-only runs, matching lipgloss's renderer.

const colorEnabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.CLICOLOR_FORCE !== undefined && process.env.CLICOLOR_FORCE !== '0') return true;
  return process.stdout.isTTY === true;
})();

const RESET = '\u001b[0m';

class Style {
  constructor(opts = {}) {
    this.opts = opts;
  }

  #with(patch) {
    return new Style({ ...this.opts, ...patch });
  }

  bold(v = true) {
    return this.#with({ bold: v });
  }

  foreground(c) {
    return this.#with({ fg: c });
  }

  background(c) {
    return this.#with({ bg: c });
  }

  padding(_vertical, horizontal) {
    return this.#with({ padH: horizontal });
  }

  #sgr(includeBoldAndFg) {
    const parts = [];
    if (includeBoldAndFg) {
      if (this.opts.bold === true) parts.push('1');
      if (this.opts.fg !== undefined) parts.push(`38;5;${this.opts.fg}`);
    }
    if (this.opts.bg !== undefined) parts.push(`48;5;${this.opts.bg}`);
    return parts.length === 0 ? '' : `\u001b[${parts.join(';')}m`;
  }

  render(text) {
    const pad = ' '.repeat(this.opts.padH ?? 0);
    if (!colorEnabled) return pad + text + pad;

    const body = this.#sgr(true);
    const inner = body === '' ? text : body + text + RESET;
    if (pad === '') return inner;

    const padSgr = this.#sgr(false);
    const padCell = padSgr === '' ? pad : padSgr + pad + RESET;
    return padCell + inner + padCell;
  }
}

export function newStyle() {
  return new Style();
}

export { colorEnabled };
