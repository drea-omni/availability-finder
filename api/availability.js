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
    throw new Error('Invalid URL — please paste the full booking link including https://');
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (hostname.includes('calendly.com')) {
    return getCalendlySlots(url, startDate, endDate, timezone);
  } else if (hostname.includes('revenuehero.io') || hostname.includes('revenuehero')) {
    return getRevenueHeroSlots(url, startDate, endDate, timezone);
  } else {
    throw new Error(
      `Unsupported platform (${hostname}). Supported: Calendly. RevenueHero support coming in v2.`
    );
  }
}

async function getCalendlySlots(url, startDate, endDate, timezone) {
  // 1. Fetch the booking page and extract the event type UUID from __NEXT_DATA__
  const pageRes = await fetch(url, { headers: BROWSER_HEADERS });
  if (!pageRes.ok) {
    throw new Error(`Could not load Calendly page (HTTP ${pageRes.status}). Check the link is public.`);
  }

  const html = await pageRes.text();

  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) {
    throw new Error('Could not parse Calendly page. Make sure this is a valid public Calendly booking link.');
  }

  let nextData;
  try {
    nextData = JSON.parse(match[1]);
  } catch {
    throw new Error('Could not read Calendly page data.');
  }

  // UUID can live in different spots depending on the event type
  const pageProps = nextData?.props?.pageProps;
  const eventType =
    pageProps?.eventType ||
    pageProps?.profile?.event_types?.[0] ||
    pageProps?.initialData?.eventType;

  const uuid = eventType?.uuid;
  if (!uuid) {
    throw new Error(
      'Could not find event type in this Calendly link. Make sure it links to a specific event type, not a profile page.'
    );
  }

  const duration = eventType?.duration || 30;

  // 2. Get available days for the full range
  const rangeUrl =
    `https://calendly.com/api/booking/event_types/${uuid}/calendar/range` +
    `?timezone=${encodeURIComponent(timezone)}&diagnostics=false&range_start=${startDate}&range_end=${endDate}`;

  const rangeRes = await fetch(rangeUrl, { headers: API_HEADERS });
  if (!rangeRes.ok) {
    throw new Error(`Calendly availability API returned ${rangeRes.status}. The event may be private or paused.`);
  }

  const rangeData = await rangeRes.json();
  const days = rangeData.days || [];

  // If spots are embedded in the range response, use them directly
  const hasEmbeddedSpots = days.some(d => Array.isArray(d.spots) && d.spots.length > 0);

  if (hasEmbeddedSpots) {
    return extractSlotsFromDays(days, duration);
  }

  // Otherwise fetch spots per available day in parallel
  const availableDays = days.filter(d => d.status === 'available');
  if (availableDays.length === 0) return [];

  const dayResults = await Promise.all(
    availableDays.map(day => {
      const dayUrl =
        `https://calendly.com/api/booking/event_types/${uuid}/calendar/range` +
        `?timezone=${encodeURIComponent(timezone)}&diagnostics=false&range_start=${day.date}&range_end=${day.date}`;
      return fetch(dayUrl, { headers: API_HEADERS })
        .then(r => (r.ok ? r.json() : { days: [] }))
        .catch(() => ({ days: [] }));
    })
  );

  const slots = [];
  dayResults.forEach(result => {
    slots.push(...extractSlotsFromDays(result.days || [], duration));
  });

  return slots;
}

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

async function getRevenueHeroSlots(url, startDate, endDate, timezone) {
  // RevenueHero booking pages are client-side rendered (React SPA).
  // Slot data is fetched via their API after the page boots — not present in the HTML.
  // v2 will add Puppeteer support to render the page and extract slots.
  throw new Error(
    'RevenueHero support is coming in v2. For now, ask your AE to share their Calendly link instead.'
  );
}

function findOverlap(allSlots) {
  if (allSlots.length === 0) return [];

  // Index every person's slots by start time
  const sets = allSlots.map(slots => new Set(slots.map(s => s.start)));

  // A slot is available for everyone if its start time appears in every person's set
  return allSlots[0].filter(slot => sets.every(set => set.has(slot.start)));
}
