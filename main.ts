import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const casesPath = path.join(inputDir, 'cases.json');
const raw = fs.readFileSync(casesPath, 'utf8');
const cases: { id?: string; markdown?: string; input?: string; text?: string }[] = JSON.parse(raw);

const html: string[] = [];
for (const c of cases) {
  const md = c.markdown ?? c.input ?? c.text ?? '';
  html.push(parse(md));
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'html.json'), JSON.stringify(html));
