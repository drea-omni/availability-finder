const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://calendly.com/',
};

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { people, startDate, endDate, timezone = 'UTC' } = req.body || {};
  if (!people?.length) return res.status(400).json({ error: 'No people provided' });

  // Fast path: try lightweight HTTP fetches in parallel
  const fastResults = await Promise.allSettled(
    people.map(p => fetchSlotsFast(p.url, startDate, endDate, timezone))
  );

  // For any that failed, try with Puppeteer (sequentially to manage RAM)
  const finalResults = [];
  for (let i = 0; i < people.length; i++) {
    const fast = fastResults[i];
    if (fast.status === 'fulfilled') {
      finalResults.push({ name: people[i].name, url: people[i].url, slots: fast.value, error: null });
    } else {
      try {
        const slots = await fetchSlotsPuppeteer(people[i].url, startDate, endDate, timezone);
        finalResults.push({ name: people[i].name, url: people[i].url, slots, error: null });
      } catch (err) {
        finalResults.push({ name: people[i].name, url: people[i].url, slots: [], error: err.message });
      }
    }
  }

  const successfulSlots = finalResults.filter(p => !p.error && p.slots.length > 0).map(p => p.slots);
  const overlap = successfulSlots.length >= 2
    ? findOverlap(successfulSlots)
    : successfulSlots[0] ?? [];

  res.status(200).json({ people: finalResults, overlap });
};

// ─── Fast path (HTTP, no browser) ────────────────────────────────────────────

async function fetchSlotsFast(url, startDate, endDate, timezone) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }

  const host = parsed.hostname.toLowerCase();
  if (host.includes('calendly.com')) return getCalendlyFast(url, parsed, startDate, endDate, timezone);
  // ScheduleHero and RevenueHero are SPAs — skip fast path
  throw new Error('SPA — needs Puppeteer');
}

async function getCalendlyFast(url, parsed, startDate, endDate, timezone) {
  const parts = parsed.pathname.split('/').filter(Boolean);
  let uuid = null, duration = 30;

  // Try Calendly's profile API
  if (parts.length >= 1 && parts[0] !== 'd') {
    const [username, eventSlug] = parts;
    try {
      const r = await fetch(`https://calendly.com/api/booking/profiles/${username}`, { headers: API_HEADERS });
      if (r.ok) {
        const body = await r.json();
        const types = body.event_types || [];
        const et = eventSlug ? (types.find(e => e.slug === eventSlug) ?? types[0]) : types[0];
        if (et?.uuid) { uuid = et.uuid; duration = et.duration ?? 30; }
      }
    } catch {}
  }

  if (!uuid) throw new Error('Calendly fast path failed — needs Puppeteer');

  return getCalendlyAvailability(uuid, duration, startDate, endDate, timezone);
}

// ─── Puppeteer path ───────────────────────────────────────────────────────────

async function fetchSlotsPuppeteer(url, startDate, endDate, timezone) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL — paste the full link including https://'); }

  const host = parsed.hostname.toLowerCase();

  if (host.includes('calendly.com')) {
    return getCalendlyPuppeteer(url, startDate, endDate, timezone);
  } else if (host.includes('schedulehero.io')) {
    return getScheduleHeroPuppeteer(url, startDate, endDate, timezone);
  } else if (host.includes('revenuehero.io')) {
    throw new Error('RevenueHero support is coming in v2. Ask your contact for a Calendly or ScheduleHero link.');
  } else {
    throw new Error(`Unsupported platform (${host}). Supported: Calendly, ScheduleHero.`);
  }
}

async function launchBrowser() {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--single-process'],
    defaultViewport: { width: 1280, height: 800 },
    executablePath: await chromium.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });
}

// Calendly via Puppeteer:
// Load the booking page, intercept the event_types API call to get the UUID,
// then close the browser and fetch the full date range with a direct API call.
async function getCalendlyPuppeteer(url, startDate, endDate, timezone) {
  const browser = await launchBrowser();

  const { uuid, duration } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.close().catch(() => {});
      reject(new Error('Timed out loading Calendly page. Make sure the link is a public booking link.'));
    }, 18000);

    browser.newPage().then(page => {
      page.setUserAgent(API_HEADERS['User-Agent']);

      // Intercept requests to extract the event type UUID
      page.on('request', req => {
        const m = req.url().match(/\/api\/booking\/event_types\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (m) {
          clearTimeout(timer);
          browser.close().catch(() => {});
          resolve({ uuid: m[1], duration: 30 });
        }
      });

      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(err => {
        clearTimeout(timer);
        browser.close().catch(() => {});
        reject(new Error(`Could not load Calendly page: ${err.message}`));
      });
    });
  });

  return getCalendlyAvailability(uuid, duration, startDate, endDate, timezone);
}

// ScheduleHero via Puppeteer:
// Load the booking page, intercept any API calls that return time slot arrays.
async function getScheduleHeroPuppeteer(url, startDate, endDate, timezone) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setUserAgent(API_HEADERS['User-Agent']);

    const slots = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setDate(end.getDate() + 1);

    page.on('response', async response => {
      const rUrl = response.url();
      // Capture any JSON response that looks like it has scheduling/slot data
      if (response.ok() && /\/(slots|availability|schedule|booking|times)/.test(rUrl)) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (!ct.includes('json')) return;
          const data = await response.json();
          const extracted = extractScheduleHeroSlots(data, start, end);
          slots.push(...extracted);
        } catch {}
      }
    });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
    // Wait a bit more for any deferred data loads
    await page.evaluate(() => new Promise(r => setTimeout(r, 3000)));

    if (slots.length === 0) {
      // Last resort: look for slot data in the rendered page's window object
      const windowSlots = await page.evaluate(() => {
        const candidates = [
          window.__INITIAL_STATE__, window.__APP_STATE__, window.__DATA__,
          window.__SH_DATA__, window.__BOOKING_DATA__,
        ];
        for (const c of candidates) {
          if (c && typeof c === 'object') return JSON.stringify(c);
        }
        return null;
      });

      if (windowSlots) {
        try {
          const data = JSON.parse(windowSlots);
          slots.push(...extractScheduleHeroSlots(data, start, end));
        } catch {}
      }
    }

    if (slots.length === 0) {
      throw new Error(
        'Could not extract availability from this ScheduleHero page. ' +
        'The page may use a non-standard API. Share the specific booking URL with the tool maintainer to add support.'
      );
    }

    return slots;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Calendly availability API ────────────────────────────────────────────────

async function getCalendlyAvailability(uuid, duration, startDate, endDate, timezone) {
  const rangeRes = await fetch(
    `https://calendly.com/api/booking/event_types/${uuid}/calendar/range` +
    `?timezone=${encodeURIComponent(timezone)}&diagnostics=false&range_start=${startDate}&range_end=${endDate}`,
    { headers: API_HEADERS }
  );
  if (!rangeRes.ok) {
    throw new Error(`Calendly returned ${rangeRes.status} fetching availability. The event may be private or paused.`);
  }

  const { days = [] } = await rangeRes.json();

  if (days.some(d => d.spots?.length > 0)) return extractSlotsFromDays(days, duration);

  const available = days.filter(d => d.status === 'available');
  if (!available.length) return [];

  const dayData = await Promise.all(
    available.map(day =>
      fetch(
        `https://calendly.com/api/booking/event_types/${uuid}/calendar/range` +
        `?timezone=${encodeURIComponent(timezone)}&diagnostics=false&range_start=${day.date}&range_end=${day.date}`,
        { headers: API_HEADERS }
      ).then(r => r.ok ? r.json() : { days: [] }).catch(() => ({ days: [] }))
    )
  );

  return dayData.flatMap(r => extractSlotsFromDays(r.days ?? [], duration));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractSlotsFromDays(days, duration) {
  return days.flatMap(day =>
    (day.spots || [])
      .filter(s => s.status === 'available' && s.start_time)
      .map(s => {
        const start = new Date(s.start_time);
        const end = s.end_time ? new Date(s.end_time) : new Date(start.getTime() + duration * 60000);
        return { start: start.toISOString(), end: end.toISOString() };
      })
  );
}

function extractScheduleHeroSlots(data, startBound, endBound) {
  // Walk common paths where scheduling tools store slot arrays
  const candidates = [
    data?.slots, data?.availability, data?.availableSlots, data?.times,
    data?.data?.slots, data?.data?.availability, data?.booking?.slots,
    data?.schedule?.slots, data?.result?.slots,
  ];

  for (const list of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue;

    const normalized = list.flatMap(slot => {
      const rawStart = slot.start_time ?? slot.startTime ?? slot.start ?? slot.datetime ?? slot;
      const rawEnd = slot.end_time ?? slot.endTime ?? slot.end ?? null;
      if (!rawStart || typeof rawStart !== 'string') return [];
      try {
        const s = new Date(rawStart);
        if (isNaN(s) || s < startBound || s >= endBound) return [];
        const e = rawEnd ? new Date(rawEnd) : new Date(s.getTime() + 30 * 60000);
        return [{ start: s.toISOString(), end: e.toISOString() }];
      } catch { return []; }
    });

    if (normalized.length > 0) return normalized;
  }
  return [];
}

function findOverlap(allSlots) {
  if (allSlots.length === 0) return [];
  const sets = allSlots.map(slots => new Set(slots.map(s => s.start)));
  return allSlots[0].filter(slot => sets.every(set => set.has(slot.start)));
}
