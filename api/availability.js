const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://calendly.com/',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { people, startDate, endDate, timezone = 'UTC' } = req.body || {};

  if (!people || !Array.isArray(people) || people.length === 0) {
    return res.status(400).json({ error: 'No people provided' });
  }

  const results = await Promise.allSettled(
    people.map(person => fetchSlots(person.url, startDate, endDate, timezone))
  );

  const peopleResults = results.map((result, i) => ({
    name: people[i].name || `Person ${i + 1}`,
    url: people[i].url,
    slots: result.status === 'fulfilled' ? result.value : [],
    error: result.status === 'rejected' ? result.reason.message : null,
  }));

  const successfulSlots = peopleResults
    .filter(p => !p.error && p.slots.length > 0)
    .map(p => p.slots);

  const overlap = successfulSlots.length >= 2
    ? findOverlap(successfulSlots)
    : successfulSlots.length === 1
    ? successfulSlots[0]
    : [];

  res.status(200).json({ people: peopleResults, overlap });
};

async function fetchSlots(url, startDate, endDate, timezone) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid URL — paste the full booking link including https://');
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (hostname.includes('calendly.com')) {
    return getCalendlySlots(url, parsedUrl, startDate, endDate, timezone);
  } else if (hostname.includes('schedulehero.io')) {
    return getScheduleHeroSlots(url, parsedUrl, startDate, endDate, timezone);
  } else if (hostname.includes('revenuehero.io')) {
    return getRevenueHeroSlots(url, startDate, endDate, timezone);
  } else {
    throw new Error(
      `Unsupported platform (${hostname}). Currently supported: Calendly, ScheduleHero. RevenueHero coming soon.`
    );
  }
}

// ─── Calendly ────────────────────────────────────────────────────────────────

async function getCalendlySlots(url, parsedUrl, startDate, endDate, timezone) {
  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  let uuid = null, duration = 30;

  // Approach 1: Calendly profile API — avoids HTML parsing entirely
  // Works for calendly.com/username and calendly.com/username/event-slug
  if (parts.length >= 1 && parts[0] !== 'd') {
    const username = parts[0];
    const eventSlug = parts[1];

    try {
      const profileRes = await fetch(
        `https://calendly.com/api/booking/profiles/${username}`,
        { headers: API_HEADERS }
      );
      if (profileRes.ok) {
        const body = await profileRes.json();
        const eventTypes = body.event_types || [];
        const et = eventSlug
          ? (eventTypes.find(e => e.slug === eventSlug) ?? eventTypes[0])
          : eventTypes[0];
        if (et?.uuid) {
          uuid = et.uuid;
          duration = et.duration ?? 30;
        }
      }
    } catch {}
  }

  // Approach 2: Parse HTML for __NEXT_DATA__ and UUID patterns
  if (!uuid) {
    const pageRes = await fetch(url, { headers: BROWSER_HEADERS });
    if (!pageRes.ok) {
      throw new Error(`Calendly page returned HTTP ${pageRes.status}. Make sure the link is public.`);
    }
    const html = await pageRes.text();

    // __NEXT_DATA__ block
    const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (ndMatch) {
      try {
        const nd = JSON.parse(ndMatch[1]);
        const pp = nd?.props?.pageProps ?? {};
        const et = pp.eventType ?? pp.profile?.event_types?.[0] ?? pp.initialData?.eventType;
        if (et?.uuid) { uuid = et.uuid; duration = et.duration ?? 30; }
      } catch {}
    }

    // Bare UUID in HTML (e.g., embedded in JS bundle references)
    if (!uuid) {
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const m = html.match(new RegExp(`"uuid"\\s*:\\s*"(${uuidRe.source})"`, 'i'))
               || html.match(new RegExp(`/event_types/(${uuidRe.source})`, 'i'));
      if (m) uuid = m[1];
    }

    if (!uuid) {
      throw new Error(
        'Could not read event data from this Calendly link. ' +
        'Use a direct event URL (calendly.com/yourname/event-name) rather than a profile page, ' +
        'and make sure the event is set to public.'
      );
    }
  }

  return getCalendlyAvailability(uuid, duration, startDate, endDate, timezone);
}

async function getCalendlyAvailability(uuid, duration, startDate, endDate, timezone) {
  const rangeUrl =
    `https://calendly.com/api/booking/event_types/${uuid}/calendar/range` +
    `?timezone=${encodeURIComponent(timezone)}&diagnostics=false&range_start=${startDate}&range_end=${endDate}`;

  const rangeRes = await fetch(rangeUrl, { headers: API_HEADERS });
  if (!rangeRes.ok) {
    throw new Error(`Calendly returned ${rangeRes.status} fetching availability. The event may be private or paused.`);
  }

  const { days = [] } = await rangeRes.json();

  // Spots embedded directly in range response
  if (days.some(d => d.spots?.length > 0)) {
    return extractSlotsFromDays(days, duration);
  }

  // Fetch per-day spots for available days
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

// ─── ScheduleHero ────────────────────────────────────────────────────────────

async function getScheduleHeroSlots(url, parsedUrl, startDate, endDate, timezone) {
  // ScheduleHero (schedulehero.io) — fetch the booking page and extract slot data.
  // Their pages may use Next.js (__NEXT_DATA__) or embed config in window globals.
  const pageRes = await fetch(url, { headers: BROWSER_HEADERS });
  if (!pageRes.ok) {
    throw new Error(`ScheduleHero page returned HTTP ${pageRes.status}. Check the link is valid.`);
  }

  const html = await pageRes.text();

  // Try __NEXT_DATA__ (Next.js)
  const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const slots = extractScheduleHeroFromNextData(nd, startDate, endDate);
      if (slots) return slots;
    } catch {}
  }

  // Try window global data patterns (common in SPAs)
  const windowPatterns = [
    /window\.__SH_(?:DATA|CONFIG|STATE)__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__INITIAL_(?:DATA|STATE)__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__APP_(?:DATA|CONFIG)__\s*=\s*(\{[\s\S]*?\});/,
  ];
  for (const pat of windowPatterns) {
    const m = html.match(pat);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const slots = extractScheduleHeroFromState(data, startDate, endDate);
        if (slots) return slots;
      } catch {}
    }
  }

  // Try to find an API base URL in the HTML to call availability directly
  const apiMatch = html.match(/["'](https?:\/\/[^"']*schedulehero[^"']*\/api\/[^"']*availability[^"']*?)["']/i);
  if (apiMatch) {
    try {
      const apiRes = await fetch(apiMatch[1], { headers: API_HEADERS });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const slots = extractScheduleHeroFromState(data, startDate, endDate);
        if (slots) return slots;
      }
    } catch {}
  }

  throw new Error(
    'Could not read availability from this ScheduleHero link. ' +
    'The page may require JavaScript to render. Please share a Calendly link as well, or contact your admin.'
  );
}

function extractScheduleHeroFromNextData(nd, startDate, endDate) {
  const pp = nd?.props?.pageProps ?? {};
  // Look for availability data in common locations
  const slots = pp.slots || pp.availability || pp.availableSlots || pp.times;
  if (Array.isArray(slots) && slots.length > 0) {
    return normalizeSlots(slots, startDate, endDate);
  }
  return null;
}

function extractScheduleHeroFromState(data, startDate, endDate) {
  // Walk common paths where scheduling tools store slot arrays
  const candidates = [
    data?.slots, data?.availability, data?.availableSlots,
    data?.booking?.slots, data?.schedule?.slots,
    data?.data?.slots, data?.data?.availability,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return normalizeSlots(candidate, startDate, endDate);
    }
  }
  return null;
}

function normalizeSlots(rawSlots, startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setDate(end.getDate() + 1); // inclusive

  return rawSlots.flatMap(slot => {
    // Handle various slot shapes: {start_time, end_time}, {startTime, endTime}, {start, end}, ISO string
    const rawStart = slot.start_time ?? slot.startTime ?? slot.start ?? slot;
    const rawEnd = slot.end_time ?? slot.endTime ?? slot.end ?? null;
    if (!rawStart) return [];

    try {
      const s = new Date(rawStart);
      if (isNaN(s) || s < start || s >= end) return [];
      const e = rawEnd ? new Date(rawEnd) : new Date(s.getTime() + 30 * 60 * 1000);
      return [{ start: s.toISOString(), end: e.toISOString() }];
    } catch { return []; }
  });
}

// ─── RevenueHero ─────────────────────────────────────────────────────────────

async function getRevenueHeroSlots(url, startDate, endDate, timezone) {
  // RevenueHero pages are client-side rendered — slot data is fetched after boot.
  // Requires headless browser support (v2).
  throw new Error(
    'RevenueHero support is coming in v2 (requires headless browser). ' +
    'For now, ask your contact to share a Calendly or ScheduleHero link.'
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractSlotsFromDays(days, duration) {
  const slots = [];
  days.forEach(day => {
    (day.spots || []).forEach(spot => {
      if (spot.status === 'available' && spot.start_time) {
        const start = new Date(spot.start_time);
        const end = spot.end_time
          ? new Date(spot.end_time)
          : new Date(start.getTime() + duration * 60 * 1000);
        slots.push({ start: start.toISOString(), end: end.toISOString() });
      }
    });
  });
  return slots;
}

function findOverlap(allSlots) {
  if (allSlots.length === 0) return [];
  const sets = allSlots.map(slots => new Set(slots.map(s => s.start)));
  return allSlots[0].filter(slot => sets.every(set => set.has(slot.start)));
}
