// The huh subset this program uses: a single-select list returning the chosen
// option's value, or an error (rendered here as null) when the user aborts.
// Only reachable on an interactive terminal, which is why it is kept minimal.

import { newStyle } from './style.js';

const stSelected = newStyle().foreground(212).bold();
const stTitle = newStyle().bold();

function render(title, options, cursor) {
  const lines = [stTitle.render(title)];
  for (let i = 0; i < options.length; i++) {
    const marker = i === cursor ? '>' : ' ';
    const label = i === cursor ? stSelected.render(options[i].label) : options[i].label;
    lines.push(`${marker} ${label}`);
  }
  return `${lines.join('\n')}\n`;
}

// selectOne resolves to the chosen value, or null when the user aborts
// (Ctrl-C / Esc / EOF) — matching huh's error return, which the caller maps
// to "quit".
export function selectOne(title, options) {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    let cursor = 0;
    let lastLineCount = 0;

    const paint = () => {
      if (lastLineCount > 0) output.write(`\u001b[${lastLineCount}A\u001b[0J`);
      const frame = render(title, options, cursor);
      output.write(frame);
      lastLineCount = frame.split('\n').length - 1;
    };

    const finish = (value) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      resolve(value);
    };

    const onData = (buf) => {
      const s = buf.toString('utf8');
      if (s === '\u0003' || s === '\u001b') return finish(null);
      if (s === '\r' || s === '\n') return finish(options[cursor].value);
      if (s === '\u001b[A' || s === 'k') {
        cursor = cursor === 0 ? options.length - 1 : cursor - 1;
        paint();
        return;
      }
      if (s === '\u001b[B' || s === 'j') {
        cursor = (cursor + 1) % options.length;
        paint();
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    paint();
  });
}
