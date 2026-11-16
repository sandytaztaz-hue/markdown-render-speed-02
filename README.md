# markdown-render-speed-02

A fast, dependency-free CommonMark 0.31.2 + GFM renderer written from
scratch. `parse(markdown)` returns exactly the HTML that marked 18.1.3
renders with its default options (gfm on, breaks off, pedantic off), and
does it several times faster than marked itself.

## Layout

- `parse.js` — the renderer. A block pass splits the document into blocks
  (collecting link reference definitions as it goes); a render pass turns
  each block into HTML, running the inline pass over its text. Inline
  tokenizing happens only after every block is known, so a reference
  defined anywhere in the document applies everywhere.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  renders each case with `parse`, writes `/output/html.json`.

## License

MIT — see `LICENSE`.
