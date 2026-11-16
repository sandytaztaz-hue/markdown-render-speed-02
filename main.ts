// Driver for the markdown-render-speed entry. The harness runs
// `node /bot/main.ts`: read every case from /input/cases.json, render each
// one alone with parse() from parse.js, and write /output/html.json, a JSON
// array of the HTML strings in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html = [];
for (let i = 0; i < cases.length; i++) html.push(parse(cases[i].markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
