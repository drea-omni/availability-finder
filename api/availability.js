const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    throw new Error(
      'ScheduleHero / RevenueHero links require a direct API integration that is coming in v2. ' +
      'For now, ask your contact to share their Calendly link instead.'
    );
  }

  throw new Error(`Unsupported platform (${host}). Supported: Calendly.`);
}

// ─── Calendly ─────────────────────────────────────────────────────────────────
//
// Flow:
//   1. GET /api/booking/profiles/{username}/event_types  → find uuid + duration by slug
//   2. GET /api/booking/event_types/{uuid}/calendar/range → get days with spots
//

async function getCalendlySlots(parsed, startDate, endDate, timezone) {
  const parts = parsed.pathname.split('/').filter(Boolean);
  const username = parts[0];
  const eventSlug = parts[1] ?? null;

  if (!username) throw new Error('Could not parse Calendly username from URL.');

  // Step 1: get event types for this user
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

  // Match by slug if provided, otherwise use first
  const et = eventSlug
    ? (types.find(t => t.slug === eventSlug) ?? types[0])
    : types[0];

  const { uuid } = et;
  if (!uuid) throw new Error('Could not find event UUID for this Calendly link.');

  // Parse duration from event name (e.g. "30 Minute Meeting" → 30)
  const durationMatch = et.name?.match(/(\d+)\s*min/i);
  const duration = durationMatch ? parseInt(durationMatch[1], 10) : 30;

  // Step 2: fetch availability range
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
  return extractSlotsFromDays(days, duration);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractSlotsFromDays(days, duration) {
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

function findOverlap(allSlots) {
  if (allSlots.length === 0) return [];
  const sets = allSlots.map(slots => new Set(slots.map(s => s.start)));
  return allSlots[0].filter(slot => sets.every(set => set.has(slot.start)));
}
