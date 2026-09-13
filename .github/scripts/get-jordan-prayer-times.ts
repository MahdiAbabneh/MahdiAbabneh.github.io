/**
 * Jordan prayer times for a whole year, from the Ministry of Awqaf.
 *
 *   node .github/scripts/get-jordan-prayer-times.ts 2027 [out.json]
 *
 * Writes prayer-times/jordan/<year>.json in the exact shape of
 * assets/jordan_prayers_times.json in the Muslim Life Guide app:
 *
 *   { "amman": { "2027-01-01": { "fajr": "06:09", ..., "isha": "07:10" } } }
 *
 * Times stay as Awqaf prints them — 12-hour with no AM/PM. The app reads them
 * that way (convert12To24Hour), and validate() below checks that reading
 * gives a sane day before anything is written.
 *
 * Plain HTTP, no browser: the page is an ASP.NET form, so a search is one POST
 * and every result page is one more postback carrying the latest __VIEWSTATE.
 *
 * Exit codes: 0 written · 2 Awqaf has not published this year yet · 1 failure.
 * Nothing is written unless every city has every day of the year.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PAGE_URL = "https://www.awqaf.gov.jo/ar/Pages/PrayerTime";

// Key order matches the app's bundled file. The Arabic names are the labels
// in the site's city list; their option values are looked up at run time.
const CITIES: ReadonlyArray<readonly [key: string, arabic: string]> = [
  ["amman", "عمان، البلقاء، الزرقاء، مادبا"],
  ["irbid", "اربد"],
  ["karak", "الكرك"],
  ["tafilah", "الطفيلة"],
  ["maan", "معان"],
  ["aqaba", "العقبة"],
  ["jerashAndAjloun", "جرش وعجلون"],
  ["mafraq", "المفرق"],
];

const PRAYERS = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"] as const;
type Day = Record<(typeof PRAYERS)[number], string>;

class NotPublished extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, "0");

// ── HTTP ────────────────────────────────────────────────────────────────────

/** One browsing session: cookies survive redirects and postbacks. */
class Session {
  private cookies = new Map<string, string>();

  async request(body?: URLSearchParams): Promise<string> {
    let url = PAGE_URL;
    let method = body ? "POST" : "GET";
    // Redirects are followed by hand — fetch drops cookies set on a 302.
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, {
        method,
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(90_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; jordan-prayer-times)",
          "Accept-Language": "ar",
          Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(method === "POST" && {
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        },
      });
      for (const header of res.headers.getSetCookie()) {
        const pair = header.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
      if (res.status >= 300 && res.status < 400) {
        await res.arrayBuffer();
        url = new URL(res.headers.get("location") ?? PAGE_URL, url).href;
        method = "GET";
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    }
    throw new Error("too many redirects");
  }
}

/** The site is slow and sometimes stalls for 30 s — retry before giving up. */
async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt === 4) throw new Error(`${label}: ${error}`);
      const wait = attempt * 10_000;
      console.warn(`  ${label}: ${error} — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

// ── HTML ────────────────────────────────────────────────────────────────────

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:$-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1].toLowerCase()] = decode(m[2]);
  }
  return out;
}

function tagById(html: string, id: string): Record<string, string> {
  const tag = html.match(new RegExp(`<(?:input|select)\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!tag) throw new Error(`#${id} not found — has the Awqaf page changed?`);
  return attributes(tag[0]);
}

/** __VIEWSTATE, __EVENTVALIDATION and friends, as the page last sent them. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const a = attributes(m[0]);
    if (a.type === "hidden" && a.name) out[a.name] = a.value ?? "";
  }
  return out;
}

function cityOptions(html: string): Map<string, string> {
  const select = html.match(/<select\b[^>]*id="MainContent_DropCompany"[^>]*>([\s\S]*?)<\/select>/);
  if (!select) throw new Error("city list not found — has the Awqaf page changed?");
  const out = new Map<string, string>();
  for (const m of select[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)) {
    out.set(decode(m[2]).trim(), attributes(m[1]).value);
  }
  return out;
}

/** Result rows keyed by the site's DD/MM/YYYY date. */
function parseRows(html: string): Map<string, Day> {
  const start = html.indexOf('id="MainContent_gvWebparts"');
  const rows = new Map<string, Day>();
  if (start < 0) return rows;
  // Splitting on <tr also splits the pager's nested table; its cells fail the
  // date/time patterns below, as does anything after the grid.
  for (const chunk of html.slice(start).split(/<tr[\s>]/i).slice(1)) {
    const cells = [...chunk.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .slice(0, 7)
      .map((m) => decode(m[1].replace(/<[^>]+>/g, "")).trim());
    if (cells.length < 7 || !/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0])) continue;
    const times = cells.slice(1);
    if (!times.every((t) => /^\d{1,2}:\d{2}$/.test(t))) continue;
    const day = {} as Day;
    PRAYERS.forEach((p, i) => (day[p] = times[i].padStart(5, "0")));
    rows.set(cells[0], day);
  }
  return rows;
}

/**
 * The grid's postback target for page [n], if the pager renders a link to it.
 * Only rendered links pass ASP.NET event validation, so pages are walked one
 * at a time — the "..." link is simply the next page number.
 */
function pagerTarget(html: string, n: number): string | undefined {
  const q = `(?:&#39;|')`;
  const re = new RegExp(`__doPostBack\\(${q}([^'&]+)${q},${q}Page\\$${n}${q}\\)`);
  return html.match(re)?.[1];
}

// ── Scrape ──────────────────────────────────────────────────────────────────

async function fetchCity(year: number, arabic: string): Promise<Map<string, Day>> {
  const session = new Session();
  let html = await withRetry(`${arabic}: open`, () => session.request());

  const value = cityOptions(html).get(arabic);
  if (!value) throw new Error(`"${arabic}" is no longer in the Awqaf city list`);

  const from = `${year}/01/01`;
  const query = {
    [tagById(html, "MainContent_DropCompany").name]: value,
    [tagById(html, "MainContent_txtFromDate").name]: from,
    [tagById(html, "MainContent_txtToDate").name]: `${year}/12/31`,
  };
  const button = tagById(html, "MainContent_btn_search");
  const post = (state: Record<string, string>, extra: Record<string, string>) =>
    new URLSearchParams({ ...state, ...query, ...extra });

  const searchState = hiddenFields(html);
  html = await withRetry(`${arabic}: search`, () =>
    session.request(post(searchState, { [button.name]: button.value })),
  );
  // An empty grid means "not published" only if the site really ran our
  // search — a session hiccup that bounced us back to a blank form must not.
  if (tagById(html, "MainContent_txtFromDate").value !== from) {
    throw new Error(`${arabic}: the search was not applied`);
  }

  const days = parseRows(html);
  for (let page = 2; days.size > 0 && !days.has(`31/12/${year}`); page++) {
    const target = pagerTarget(html, page);
    if (!target) break;
    const state = hiddenFields(html);
    html = await withRetry(`${arabic}: page ${page}`, () =>
      session.request(post(state, { __EVENTTARGET: target, __EVENTARGUMENT: `Page$${page}` })),
    );
    const before = days.size;
    for (const [date, day] of parseRows(html)) days.set(date, day);
    if (days.size === before) throw new Error(`${arabic}: page ${page} added no new days`);
    await sleep(300);
  }
  return days;
}

/** Minutes after midnight, read the way the app's convert12To24Hour reads it. */
function minutes(time: string, prayerIndex: number): number {
  let [h, m] = time.split(":").map(Number);
  if (prayerIndex <= 1 && h === 12) h = 0;
  if (prayerIndex >= 3 && h < 12) h += 12;
  return h * 60 + m;
}

/** Every day of [year], in order, each day's prayers in order — or throw. */
function validate(key: string, year: number, days: Map<string, Day>): Record<string, Day> {
  const out: Record<string, Day> = {};
  const d = new Date(Date.UTC(year, 0, 1));
  for (; d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    const dd = pad(d.getUTCDate());
    const mm = pad(d.getUTCMonth() + 1);
    const day = days.get(`${dd}/${mm}/${year}`);
    if (!day) throw new Error(`${key}: ${year}-${mm}-${dd} is missing (${days.size} days found)`);
    const m = PRAYERS.map((p, i) => minutes(day[p], i));
    if (m.some((v, i) => i > 0 && v <= m[i - 1])) {
      throw new Error(`${key}: ${year}-${mm}-${dd} times are out of order ${JSON.stringify(day)}`);
    }
    out[`${year}-${mm}-${dd}`] = day;
  }
  const extra = days.size - Object.keys(out).length;
  if (extra) throw new Error(`${key}: ${extra} rows outside ${year}`);
  return out;
}

async function main() {
  const year = Number(process.argv[2]);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error("usage: node get-jordan-prayer-times.ts <year> [out.json]");
  }
  const outPath = resolve(process.argv[3] ?? `prayer-times/jordan/${year}.json`);

  const result: Record<string, Record<string, Day>> = {};
  for (const [key, arabic] of CITIES) {
    const started = Date.now();
    const days = await fetchCity(year, arabic);
    if (days.size === 0) {
      // Awqaf publishes the whole year at once, so an empty first city means
      // the year is not out yet. An empty later city is a real failure.
      if (key === CITIES[0][0]) throw new NotPublished(`${year} is not published yet`);
      throw new Error(`${key}: no rows, although ${CITIES[0][0]} had them`);
    }
    result[key] = validate(key, year, days);
    console.log(`${key}: ${days.size} days in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(`${outPath}.tmp`, JSON.stringify(result));
  await rename(`${outPath}.tmp`, outPath);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  if (error instanceof NotPublished) {
    console.log(error.message);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
});
