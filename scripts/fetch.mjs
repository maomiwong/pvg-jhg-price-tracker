// 抓取 PVG/SHA → JHG 未来 4 个锚点日期的最低价
// 数据源：Trip.com 国际版（FlightMiddleSearch API），currency=USD，转 CNY
// 写入：data/prices.jsonl  失败：data/runs.jsonl
//
// 用法: node scripts/fetch.mjs

import { chromium } from 'playwright';
import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DATA_DIR = join(REPO_ROOT, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const PRICES_FILE = join(DATA_DIR, 'prices.jsonl');
const RUNS_FILE = join(DATA_DIR, 'runs.jsonl');

// ── 配置 ─────────────────────────────────────────────────
const ORIGINS = ['PVG', 'SHA'];
const DAYS_OUT = [7, 14, 21, 28];
// ─────────────────────────────────────────────────────────

function shanghaiISO() {
  // 当前 Asia/Shanghai 时间的 ISO 8601 with +08:00
  const d = new Date();
  const sh = new Date(d.getTime() + (8 * 60 - d.getTimezoneOffset()) * 60000);
  const pad = n => String(n).padStart(2, '0');
  return `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth()+1)}-${pad(sh.getUTCDate())}T${pad(sh.getUTCHours())}:${pad(sh.getUTCMinutes())}:${pad(sh.getUTCSeconds())}+08:00`;
}

function shanghaiDateOffset(daysOffset) {
  const d = new Date();
  const sh = new Date(d.getTime() + (8 * 60 - d.getTimezoneOffset()) * 60000);
  sh.setUTCDate(sh.getUTCDate() + daysOffset);
  const pad = n => String(n).padStart(2, '0');
  return `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth()+1)}-${pad(sh.getUTCDate())}`;
}

// 拉 USD→CNY 汇率
async function getUsdToCnyRate() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return j?.rates?.CNY ?? null;
  } catch (e) {
    return null;
  }
}

async function fetchOne(browser, origin, dest, depDate) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 800 },
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  const responses = [];
  page.on('response', async (resp) => {
    if (!resp.url().includes('FlightMiddleSearch')) return;
    try { responses.push(await resp.text()); } catch {}
  });

  const url = `https://www.trip.com/flights/showfarefirst?dcity=${origin.toLowerCase()}&acity=${dest.toLowerCase()}&triptype=ow&class=y&quantity=1&searchdate=${depDate}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(20000);
  } catch (e) {
    await ctx.close();
    return { ok: false, error: 'goto: ' + e.message };
  }

  await ctx.close();

  if (!responses.length) return { ok: false, error: 'no FlightMiddleSearch response' };

  // 取最大的 response
  const biggest = responses.sort((a, b) => b.length - a.length)[0];
  let j;
  try { j = JSON.parse(biggest); } catch (e) { return { ok: false, error: 'parse: ' + e.message }; }

  const currency = j.basicInfo?.currency ?? 'USD';
  const policies = j.policyList ?? [];
  if (!policies.length) return { ok: false, error: 'empty policyList', currency };

  // 找最低价
  let minPrice = null;
  for (const p of policies) {
    const price = p?.price?.adult?.price;
    if (typeof price === 'number' && price > 0) {
      if (minPrice === null || price < minPrice) minPrice = price;
    }
  }
  if (minPrice === null) return { ok: false, error: 'no price in policyList', currency };

  // 找航班号（用第一个 journey 的第一个 transport segment）
  let flightNo = '';
  const journey0 = j.journeyList?.[0];
  if (journey0?.transportList?.[0]) {
    const seg = journey0.transportList[0];
    flightNo = seg.flightNo ?? seg.marketAirlineCode ?? '';
  }

  return { ok: true, currency, minPrice, flightNo };
}

async function main() {
  const snapshotAt = shanghaiISO();
  const rate = await getUsdToCnyRate();
  console.log(`[${snapshotAt}] USD→CNY rate: ${rate ?? 'unknown (will fall back to 7.2)'}`);
  const usdToCny = rate ?? 7.2;

  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });

  const results = [];
  for (const origin of ORIGINS) {
    for (const offset of DAYS_OUT) {
      const depDate = shanghaiDateOffset(offset);
      console.log(`Fetching ${origin}→JHG ${depDate}...`);
      let r;
      try {
        r = await fetchOne(browser, origin, 'JHG', depDate);
      } catch (e) {
        r = { ok: false, error: 'fetchOne threw: ' + e.message };
      }
      results.push({ origin, depDate, ...r });
      console.log(`  -> ${r.ok ? '✅ ' + r.minPrice + ' ' + (r.currency||'') + ' (' + (r.flightNo||'?') + ')' : '❌ ' + r.error}`);
    }
  }

  await browser.close();

  // 写入 prices.jsonl
  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);

  for (const r of ok) {
    const cny = r.currency === 'CNY' ? r.minPrice : Math.round(r.minPrice * usdToCny);
    const rec = {
      snapshot_at: snapshotAt,
      depart_date: r.depDate,
      origin: r.origin,
      destination: 'JHG',
      min_price_cny: cny,
      raw_price: r.minPrice,
      raw_currency: r.currency,
      usd_to_cny: usdToCny,
      carrier: r.flightNo || '',
      source: 'trip.com',
    };
    appendFileSync(PRICES_FILE, JSON.stringify(rec) + '\n');
  }

  // 写入 runs.jsonl
  appendFileSync(RUNS_FILE, JSON.stringify({
    snapshot_at: snapshotAt,
    success: ok.length,
    fail: fail.length,
    usd_to_cny: usdToCny,
    errors: fail.map(f => ({ origin: f.origin, depDate: f.depDate, error: f.error })),
  }) + '\n');

  // 输出 summary（agent 总结用）
  console.log(`\n========== SUMMARY ==========`);
  console.log(`抓取成功: ${ok.length}/${results.length}`);
  console.log(`USD→CNY 汇率: ${usdToCny}`);
  console.log(`\n各组合最低价 (CNY):`);
  for (const r of ok) {
    const cny = r.currency === 'CNY' ? r.minPrice : Math.round(r.minPrice * usdToCny);
    console.log(`  ${r.origin}→JHG ${r.depDate}  ¥${cny}  ${r.flightNo||''}`);
  }
  if (fail.length) {
    console.log(`\n失败:`);
    fail.forEach(f => console.log(`  ${f.origin}→JHG ${f.depDate}: ${f.error}`));
  }

  // 退出码：全失败 → 1，其他 → 0
  process.exit(ok.length === 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
