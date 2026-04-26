// 读 data/prices.jsonl，把数据注入 index.html 模板
// 用法: node scripts/render.mjs

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PRICES_FILE = join(REPO_ROOT, 'data', 'prices.jsonl');
const HTML_FILE = join(REPO_ROOT, 'index.html');

const prices = existsSync(PRICES_FILE)
  ? readFileSync(PRICES_FILE, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

const html = readFileSync(HTML_FILE, 'utf-8');
const newHtml = html.replace(
  /const PRICES = \[[\s\S]*?\];/,
  `const PRICES = ${JSON.stringify(prices, null, 0)};`
);

writeFileSync(HTML_FILE, newHtml);
console.log(`✅ index.html 注入完成 (${prices.length} 条价格记录)`);
