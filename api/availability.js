const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
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

  const results = await Promise.allSettled(
    people.map(p => fetchSlots(p.url, startDate, endDate, timezone))
  );

  const finalResults = people.map((person, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      return { name: person.name, url: person.url, slots: r.value, error: null };
    } else {
      return { name: person.name, url: person.url, slots: [], error: r.reason?.message || 'Unknown error' };
    }
  });

  const successfulSlots = finalResults.filter(p => !p.error && p.slots.length > 0).map(p => p.slots);
  const overlap = successfulSlots.length >= 2
    ? findOverlap(successfulSlots)
    : successfulSlots[0] ?? [];

  res.status(200).json({ people: finalResults, overlap });
};

// ─── Platform router ──────────────────────────────────────────────────────────

async function fetchSlots(url, startDate, endDate, timezone) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL — paste the full link including https://'); }

  const host = parsed.hostname.toLowerCase();

  if (host.includes('calendly.com')) {
    return getCalendlySlots(parsed, startDate, endDate, timezone);
  }

  if (host.includes('schedulehero.io') || host.includes('revenuehero.io')) {
    return getScheduleHeroSlots(url, startDate, endDate, timezone);
  }

  throw new Error(`Unsupported platform (${host}). Supported: Calendly, ScheduleHero.`);
}

// ─── Calendly ─────────────────────────────────────────────────────────────────
//
// 1. GET /api/booking/profiles/{username}/event_types → uuid + name
// 2. GET /api/booking/event_types/{uuid}/calendar/range → days with spots
//

async function getCalendlySlots(parsed, startDate, endDate, timezone) {
  const parts = parsed.pathname.split('/').filter(Boolean);
  const username = parts[0];
  const eventSlug = parts[1] ?? null;

  if (!username) throw new Error('Could not parse Calendly username from URL.');

  const typesRes = await fetch(
    `https://calendly.com/api/booking/profiles/${username}/event_types`,
    { headers: API_HEADERS }
  );

  if (!typesRes.ok) {
    throw new Error(
      `Calendly returned ${typesRes.status} for "${username}". ` +
      'Make sure the link is a public Calendly booking URL.'
    );
  }

  const types = await typesRes.json();
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error(`No booking types found for ${username}.`);
  }

  const et = eventSlug
    ? (types.find(t => t.slug === eventSlug) ?? types[0])
    : types[0];

  const { uuid } = et;
  if (!uuid) throw new Error('Could not find event UUID for this Calendly link.');

  const durationMatch = et.name?.match(/(\d+)\s*min/i);
  const duration = durationMatch ? parseInt(durationMatch[1], 10) : 30;

  return getCalendlyAvailability(uuid, duration, startDate, endDate, timezone);
}

async function getCalendlyAvailability(uuid, duration, startDate, endDate, timezone) {
  const url =
    `https://calendly.com/api/booking/event_types/${uuid}/calendar/range` +
    `?timezone=${encodeURIComponent(timezone)}&diagnostics=false&range_start=${startDate}&range_end=${endDate}`;

  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) {
    throw new Error(`Calendly returned ${res.status} fetching availability. The event may be private or paused.`);
  }

  const { days = [] } = await res.json();
  return extractCalendlySlots(days, duration);
}

function extractCalendlySlots(days, duration) {
  return days.flatMap(day =>
    (day.spots || [])
      .filter(s => s.status === 'available' && s.start_time)
      .map(s => {
        const start = new Date(s.start_time);
        const end = new Date(start.getTime() + duration * 60000);
        return { start: start.toISOString(), end: end.toISOString() };
      })
  );
}

// ─── ScheduleHero via Browserless ────────────────────────────────────────────
//
// Connects to a remote Chrome instance (Browserless.io) to render the
// ScheduleHero booking page and intercept the slot API responses.
//

async function getScheduleHeroSlots(url, startDate, endDate, timezone) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ScheduleHero support requires a Browserless API key. ' +
      'Add BROWSERLESS_API_KEY to your Vercel environment variables.'
    );
  }

  const puppeteer = require('puppeteer-core');

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${apiKey}`,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(API_HEADERS['User-Agent']);

    const start = new Date(startDate);
    const end = new Date(endDate);
    const daysNeeded = Math.ceil((end - start) / (24 * 60 * 60 * 1000));
    const weeksToClick = Math.ceil(daysNeeded / 7);

    const rawSlots = [];
    let duration = 30;

    // Intercept all JSON responses that look like slot data
    page.on('response', async response => {
      const rUrl = response.url();
      const method = response.request().method();
      if (method !== 'GET') return;
      if (!/\/(personal_time_slots|time_slots|campaign_time_slots|link_sessions|relay_time_slots)(\?|$)/.test(rUrl)) return;

      try {
        const data = await response.json();
        const attrs = data?.data?.attributes || {};
        if (Array.isArray(attrs.meeting_slots) && attrs.meeting_slots.length > 0) {
          rawSlots.push(...attrs.meeting_slots);
        }
        // Extract duration from included meeting_type if present
        const mt = (data?.included || []).find(i => i.type === 'meeting_type');
        if (mt?.attributes?.duration) duration = mt.attributes.duration;
      } catch {}
    });

    // Load page — initial render shows current week
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2000);

    // Click forward to get subsequent weeks
    for (let week = 0; week < weeksToClick; week++) {
      const clicked = await page.evaluate(() => {
        // The next-week button is the last SVG button in the calendar nav
        const buttons = [...document.querySelectorAll('button')].filter(b => b.querySelector('svg') && b.offsetParent !== null);
        if (buttons.length >= 2) {
          buttons[buttons.length - 1].click();
          return true;
        }
        // Fallback: any button with a right-pointing aria-label
        const nextBtn = document.querySelector('[aria-label*="next" i], [aria-label*="forward" i], [aria-label*="right" i]');
        if (nextBtn) { nextBtn.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await sleep(2500);
    }

    if (rawSlots.length === 0) {
      throw new Error(
        'Could not load availability from this ScheduleHero page. ' +
        'Make sure the link is a public ScheduleHero booking URL.'
      );
    }

    // Dedupe, filter to requested range, and sort
    return [...new Set(rawSlots)]
      .flatMap(slot => {
        try {
          const s = new Date(slot);
          if (isNaN(s) || s < start || s >= end) return [];
          return [{ start: s.toISOString(), end: new Date(s.getTime() + duration * 60000).toISOString() }];
        } catch { return []; }
      })
      .sort((a, b) => a.start.localeCompare(b.start));

  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findOverlap(allSlots) {
  if (allSlots.length === 0) return [];
  const sets = allSlots.map(slots => new Set(slots.map(s => s.start)));
  return allSlots[0].filter(slot => sets.every(set => set.has(slot.start)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
