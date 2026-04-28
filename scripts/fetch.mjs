// 抓取 Trip.com 国际版返回的 PVG/SHA → JHG 全量航班数据
// 每次跑：尝试 4 个目标日期（today+7/+14/+21/+28），合并所有航班记录
// 每条记录 = 一个航班的一次价格快照
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

const TARGET_OFFSETS = [7, 14, 21, 28]; // 相对今天的天数
const ORIGIN_CITY = 'sha'; // Trip.com 用 city code 'sha' 会自动覆盖 PVG+SHA 两个机场

function shanghaiISO() {
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

async function getUsdToCny() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    return j?.rates?.CNY ?? 7.2;
  } catch { return 7.2; }
}

// 抓单个日期 + 城市，返回所有航班的最低价数组
async function fetchOneDate(browser, depDate) {
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

  const url = `https://www.trip.com/flights/showfarefirst?dcity=${ORIGIN_CITY}&acity=jhg&triptype=ow&class=y&quantity=1&searchdate=${depDate}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000);
    // 触发 lazy load 拿更多航班
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000);
  } catch (e) {
    await ctx.close();
    return { ok: false, error: 'goto: ' + e.message, requested_date: depDate };
  }

  await ctx.close();

  if (!responses.length) return { ok: false, error: 'no FlightMiddleSearch', requested_date: depDate };

  // 每个 response = 一个航班 (1 journey + N policies)
  const flights = [];
  let currency = 'USD';
  for (const body of responses) {
    let j;
    try { j = JSON.parse(body); } catch { continue; }
    currency = j.basicInfo?.currency || currency;
    const journey = j.journeyList?.[0];
    if (!journey) continue;
    const transports = journey.transportList || [];
    if (!transports.length) continue;
    const t0 = transports[0];
    const last = transports[transports.length - 1];

    const flightNo = t0.flight?.flightNo;
    if (!flightNo) continue;

    const depAirport = t0.departPoint?.airPort?.airportCode || '';
    const arrAirport = last.arrivePoint?.airPort?.airportCode || '';
    const carrier = t0.flight?.airlineInfo?.name || t0.flight?.airlineInfo?.code || '';
    const aircraft = t0.craftInfo?.craftName || t0.craftInfo?.craftType || '';
    const departDt = t0.dateInfo?.departDate || ''; // "2026-04-29 06:00:00"
    const arriveDt = last.dateInfo?.arriveDate || '';
    const duration = journey.duration || 0;
    const stops = (transports.length - 1) +
      (transports.reduce((s, t) => s + (t.stop?.stopInfo?.length || 0), 0));

    // 该航班最低价
    const minPolicy = Math.min(...(j.policyList || []).map(p => p?.price?.adult?.price ?? Infinity));
    if (!isFinite(minPolicy)) continue;

    flights.push({
      flightNo, carrier, aircraft,
      depAirport, arrAirport,
      departDateTime: departDt,
      arriveDateTime: arriveDt,
      duration, stops,
      raw_price: minPolicy, raw_currency: currency,
    });
  }

  return { ok: true, requested_date: depDate, flights };
}

async function main() {
  const snapshotAt = shanghaiISO();
  const usdToCny = await getUsdToCny();
  console.log(`[${snapshotAt}] USD→CNY = ${usdToCny}`);

  const browser = await chromium.launch({ headless: true });

  let totalFlights = 0;
  let runErrors = [];

  for (const offset of TARGET_OFFSETS) {
    const depDate = shanghaiDateOffset(offset);
    console.log(`\n=== 查询 today+${offset} (${depDate}) ===`);
    const r = await fetchOneDate(browser, depDate);
    if (!r.ok) {
      console.log(`  ❌ ${r.error}`);
      runErrors.push({ requested_date: depDate, error: r.error });
      continue;
    }
    console.log(`  ✅ ${r.flights.length} 个航班`);
    for (const f of r.flights) {
      // depart_date 用 trip.com 实际返回的（YYYY-MM-DD 部分）
      const actualDate = (f.departDateTime || depDate).slice(0, 10);
      const cny = f.raw_currency === 'CNY' ? f.raw_price : Math.round(f.raw_price * usdToCny);

      const rec = {
        snapshot_at: snapshotAt,
        depart_date: actualDate,
        requested_date: depDate, // 我们想查的，可能和 trip.com 实际返回不一致
        flight_no: f.flightNo,
        carrier: f.carrier,
        aircraft: f.aircraft,
        dep_airport: f.depAirport,
        arr_airport: f.arrAirport,
        dep_datetime: f.departDateTime,
        arr_datetime: f.arriveDateTime,
        duration_min: f.duration,
        stops: f.stops,
        price_cny: cny,
        raw_price: f.raw_price,
        raw_currency: f.raw_currency,
        usd_to_cny: usdToCny,
        source: 'trip.com',
      };
      appendFileSync(PRICES_FILE, JSON.stringify(rec) + '\n');
      totalFlights++;
      console.log(`    ${f.flightNo}  ${f.depAirport}→${f.arrAirport}  ${f.departDateTime?.slice(0,16)}  ¥${cny}`);
    }
  }

  await browser.close();

  appendFileSync(RUNS_FILE, JSON.stringify({
    snapshot_at: snapshotAt,
    flights_captured: totalFlights,
    errors: runErrors,
    usd_to_cny: usdToCny,
  }) + '\n');

  console.log(`\n========== SUMMARY ==========`);
  console.log(`本次抓取: ${totalFlights} 条航班记录`);
  console.log(`失败查询: ${runErrors.length}`);
  console.log(`USD→CNY 汇率: ${usdToCny}`);

  process.exit(totalFlights > 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
