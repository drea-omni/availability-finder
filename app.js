'use strict';

// ─── Color palette ────────────────────────────────────────────────────────────

const COLORS = [
  { stripe: '#3B82F6', dot: '#3B82F6', bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
  { stripe: '#8B5CF6', dot: '#8B5CF6', bg: '#F5F3FF', border: '#DDD6FE', text: '#6D28D9' },
  { stripe: '#EC4899', dot: '#EC4899', bg: '#FDF2F8', border: '#FBCFE8', text: '#BE185D' },
  { stripe: '#F59E0B', dot: '#F59E0B', bg: '#FFFBEB', border: '#FDE68A', text: '#B45309' },
  { stripe: '#10B981', dot: '#10B981', bg: '#ECFDF5', border: '#6EE7B7', text: '#047857' },
  { stripe: '#EF4444', dot: '#EF4444', bg: '#FFF1F2', border: '#FECDD3', text: '#BE123C' },
  { stripe: '#06B6D4', dot: '#06B6D4', bg: '#ECFEFF', border: '#A5F3FC', text: '#0E7490' },
  { stripe: '#84CC16', dot: '#84CC16', bg: '#F7FEE7', border: '#D9F99D', text: '#3F6212' },
];

// ─── Timezones ────────────────────────────────────────────────────────────────

const TIMEZONES = [
  { label: 'Pacific Time (PT)',   value: 'America/Los_Angeles' },
  { label: 'Mountain Time (MT)',  value: 'America/Denver' },
  { label: 'Central Time (CT)',   value: 'America/Chicago' },
  { label: 'Eastern Time (ET)',   value: 'America/New_York' },
  { label: 'Atlantic Time (AT)', value: 'America/Halifax' },
  { label: 'UTC',                 value: 'UTC' },
  { label: 'London (GMT/BST)',    value: 'Europe/London' },
  { label: 'Paris / Berlin (CET)', value: 'Europe/Paris' },
  { label: 'Dubai (GST)',         value: 'Asia/Dubai' },
  { label: 'Mumbai (IST)',        value: 'Asia/Kolkata' },
  { label: 'Singapore (SGT)',     value: 'Asia/Singapore' },
  { label: 'Tokyo (JST)',         value: 'Asia/Tokyo' },
  { label: 'Sydney (AEST)',       value: 'Australia/Sydney' },
  { label: 'Auckland (NZST)',     value: 'Pacific/Auckland' },
];

// ─── Calendar constants ───────────────────────────────────────────────────────

const CAL_HOUR_HEIGHT = 52;   // px per hour
const CAL_START_HOUR  = 7;    // 7 AM
const CAL_END_HOUR    = 21;   // 9 PM
const CAL_TOTAL_H     = (CAL_END_HOUR - CAL_START_HOUR) * CAL_HOUR_HEIGHT;

// ─── State ────────────────────────────────────────────────────────────────────

let people = [];
let nextId = 1;
let selectedDays = 14;
let lastResults = null;
let displayTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let viewMode = 'list';
let calendarWeekOffset = 0;
let pullStartDate = null;
let pullEndDate = null;
let customRangeMode = false;
let customStartDate = null;
let customEndDate = null;

// ─── People management ───────────────────────────────────────────────────────

function addPerson(name = '', url = '') {
  people.push({ id: nextId++, name, url });
  renderPeople();
}

function removePerson(id) {
  people = people.filter(p => p.id !== id);
  renderPeople();
}

function updatePerson(id, field, value) {
  const p = people.find(p => p.id === id);
  if (p) p[field] = value;
}

function colorForIndex(i) {
  return COLORS[i % COLORS.length];
}

function renderPeople() {
  const list = document.getElementById('people-list');
  list.innerHTML = '';

  people.forEach((person, i) => {
    const c = colorForIndex(i);
    const canRemove = people.length > 1;

    const row = document.createElement('div');
    row.className = 'person-row';
    row.dataset.personId = person.id;

    row.innerHTML = `
      <div class="person-color-stripe" style="background:${c.stripe}"></div>
      <div class="person-name-wrap">
        <span class="person-color-dot" style="background:${c.dot}"></span>
        <input
          class="person-name-input"
          type="text"
          placeholder="Name"
          value="${esc(person.name)}"
          data-id="${person.id}"
          data-field="name"
          autocomplete="off"
        />
      </div>
      <input
        class="person-url-input"
        type="url"
        placeholder="Paste Calendly or RevenueHero booking link"
        value="${esc(person.url)}"
        data-id="${person.id}"
        data-field="url"
        autocomplete="off"
        spellcheck="false"
      />
      ${canRemove
        ? `<button class="btn-remove" data-remove="${person.id}" title="Remove" aria-label="Remove ${esc(person.name) || 'person'}">×</button>`
        : '<div class="person-row-ghost"></div>'
      }
    `;

    list.appendChild(row);
  });

  list.querySelectorAll('.person-name-input, .person-url-input').forEach(input => {
    input.addEventListener('input', e => {
      updatePerson(+e.target.dataset.id, e.target.dataset.field, e.target.value);
    });
  });

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      removePerson(+e.currentTarget.dataset.remove);
    });
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${name}`);
  });
}

// ─── Timezone selector ───────────────────────────────────────────────────────

function buildTimezoneSelector() {
  const sel = document.getElementById('tz-select');
  if (!sel) return;

  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const list = [...TIMEZONES];

  if (!list.find(t => t.value === userTz)) {
    const abbr = new Intl.DateTimeFormat('en-US', { timeZone: userTz, timeZoneName: 'short' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
    const city = userTz.split('/').pop().replace(/_/g, ' ');
    list.unshift({ label: `${city} (${abbr})`, value: userTz });
  }

  sel.innerHTML = list.map(tz =>
    `<option value="${tz.value}"${tz.value === displayTimezone ? ' selected' : ''}>${tz.label}</option>`
  ).join('');

  sel.addEventListener('change', () => {
    displayTimezone = sel.value;
    if (lastResults) renderResults(lastResults);
  });
}

// ─── View toggle ─────────────────────────────────────────────────────────────

function switchView(mode) {
  viewMode = mode;
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  const calEl = document.getElementById('calendar-view');
  const listEl = document.getElementById('list-view');
  if (calEl)  calEl.classList.toggle('hidden', mode !== 'calendar');
  if (listEl) listEl.classList.toggle('hidden', mode === 'calendar');
  if (mode === 'calendar' && lastResults) renderCalendar(lastResults);
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function findTimes() {
  const valid = people.filter(p => p.url.trim());
  if (valid.length === 0) {
    alert('Add at least one booking link to continue.');
    return;
  }

  switchTab('results');
  setResultsState('loading');

  let startDay, endDay;
  if (customRangeMode && customStartDate && customEndDate) {
    startDay = new Date(customStartDate + 'T00:00:00');
    endDay   = new Date(customEndDate   + 'T00:00:00');
    endDay.setDate(endDay.getDate() + 1); // inclusive end
  } else {
    startDay = new Date();
    endDay   = new Date();
    endDay.setDate(endDay.getDate() + selectedDays);
  }
  pullStartDate = fmtDate(startDay);
  pullEndDate   = fmtDate(endDay);

  try {
    const res = await fetch('/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        people: valid,
        startDate: pullStartDate,
        endDate:   pullEndDate,
        timezone: displayTimezone,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server error (${res.status})`);
    }

    lastResults = await res.json();
    renderResults(lastResults);
    setResultsState('content');

    const badge = document.getElementById('overlap-tab-badge');
    if (lastResults.overlap && lastResults.overlap.length > 0) {
      badge.textContent = lastResults.overlap.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (err) {
    setResultsState('error', err.message);
  }
}

// ─── Results rendering ───────────────────────────────────────────────────────

function renderResults(data) {
  renderOverlap(data.overlap || []);
  renderIndividual(data.people || [], data.overlap || []);
  if (viewMode === 'calendar') renderCalendar(data);
}

function renderOverlap(overlap) {
  const tz = displayTimezone;
  const countEl = document.getElementById('overlap-count');
  const container = document.getElementById('overlap-days');
  const copyBtn = document.getElementById('btn-copy');

  countEl.textContent = overlap.length;
  countEl.classList.toggle('hidden', overlap.length === 0);
  copyBtn.classList.toggle('hidden', overlap.length === 0);

  if (overlap.length === 0) {
    container.innerHTML = '<div class="no-overlap">No overlapping availability found in this range. Try expanding the date range or checking individual schedules below.</div>';
    return;
  }

  const byDay = groupByDay(overlap, tz);
  container.innerHTML = Object.entries(byDay).map(([label, slots]) => `
    <div class="day-group">
      <div class="day-group-header">${label}</div>
      <div class="day-group-slots">
        ${slots.map(s => `<span class="slot-pill">${fmtTimeRange(s.start, s.end, tz)}</span>`).join('')}
      </div>
    </div>
  `).join('');
}

function renderIndividual(peopleData, overlap) {
  const tz = displayTimezone;
  const grid = document.getElementById('individual-grid');
  const overlapStarts = new Set(overlap.map(s => s.start));

  const colCount = Math.min(peopleData.length, 3);
  grid.style.gridTemplateColumns = `repeat(${colCount}, minmax(200px, 1fr))`;

  grid.innerHTML = peopleData.map((person, i) => {
    const c = colorForIndex(i);
    const name = esc(person.name || `Person ${i + 1}`);

    if (person.error) {
      return `
        <div class="person-col">
          <div class="person-col-header">
            <span class="person-col-dot" style="background:${c.dot}"></span>
            <span class="person-col-name" style="color:${c.text}">${name}</span>
          </div>
          <div class="person-col-body">
            <div class="error-pill">${esc(person.error)}</div>
          </div>
        </div>`;
    }

    const slots = person.slots || [];

    if (slots.length === 0) {
      return `
        <div class="person-col">
          <div class="person-col-header" style="background:${c.bg};border-color:${c.border}">
            <span class="person-col-dot" style="background:${c.dot}"></span>
            <span class="person-col-name" style="color:${c.text}">${name}</span>
          </div>
          <div class="person-col-body">
            <p class="no-slots-msg">No availability in this range.</p>
          </div>
        </div>`;
    }

    const byDay = groupByDay(slots, tz);

    const daysHtml = Object.entries(byDay).map(([label, daySlots]) => `
      <div class="person-day-section">
        <div class="person-day-label">${label}</div>
        <div class="person-slots">
          ${daySlots.map(s => {
            const inOverlap = overlapStarts.has(s.start);
            return `<span
              class="person-slot-pill${inOverlap ? ' in-overlap' : ''}"
              style="background:${c.bg};border-color:${inOverlap ? c.dot : c.border};color:${c.text}"
              title="${inOverlap ? '✓ Works for everyone' : ''}"
            >${fmtTime(s.start, tz)}</span>`;
          }).join('')}
        </div>
      </div>
    `).join('');

    return `
      <div class="person-col">
        <div class="person-col-header" style="background:${c.bg};border-color:${c.border}">
          <span class="person-col-dot" style="background:${c.dot}"></span>
          <span class="person-col-name" style="color:${c.text}">${name}</span>
          <span class="person-col-count">${slots.length} slots</span>
        </div>
        <div class="person-col-body">${daysHtml}</div>
      </div>`;
  }).join('');
}

// ─── Calendar view ────────────────────────────────────────────────────────────

function renderCalendar(data) {
  const tz = displayTimezone;
  const dates = getWeekDates(calendarWeekOffset);

  // Week label
  const d0 = new Date(dates[0] + 'T12:00:00');
  const d6 = new Date(dates[6] + 'T12:00:00');
  const labelEl = document.getElementById('cal-week-label');
  if (labelEl) {
    labelEl.textContent =
      d0.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' – ' +
      d6.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const overlapSet = new Set((data.overlap || []).map(s => s.start));
  const peopleData = data.people || [];
  const numPeople = Math.max(peopleData.length, 1);
  const today = getTodayKey();

  // Group slots by day key in display timezone
  const slotsByDay = {};
  dates.forEach(dk => { slotsByDay[dk] = []; });

  peopleData.forEach((person, pi) => {
    (person.slots || []).forEach(slot => {
      const dk = getLocalDayKey(slot.start, tz);
      if (slotsByDay[dk]) {
        slotsByDay[dk].push({ pi, slot, inOverlap: overlapSet.has(slot.start) });
      }
    });
  });

  // Header cells
  const headerHtml = dates.map(dk => {
    const d = new Date(dk + 'T12:00:00');
    const isToday = dk === today;
    const isOOR = pullStartDate && pullEndDate ? (dk < pullStartDate || dk >= pullEndDate) : false;
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dayNum  = d.getDate();
    return `
      <div class="cal-day-head${isToday ? ' is-today' : ''}${isOOR ? ' out-of-range' : ''}">
        <span class="cal-head-name">${dayName}</span>
        <span class="cal-head-num${isToday && !isOOR ? ' is-today' : ''}">${dayNum}</span>
      </div>`;
  }).join('');

  // Time axis labels
  let timeHtml = '';
  for (let h = CAL_START_HOUR; h <= CAL_END_HOUR; h++) {
    const top = (h - CAL_START_HOUR) * CAL_HOUR_HEIGHT;
    const lbl = h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`;
    timeHtml += `<div class="cal-hour-label" style="top:${top}px">${lbl}</div>`;
  }

  // Day columns
  const dayColsHtml = dates.map(dk => {
    // Hour + half-hour lines
    let linesHtml = '';
    for (let h = 0; h < (CAL_END_HOUR - CAL_START_HOUR); h++) {
      linesHtml += `<div class="cal-h-line"  style="top:${h * CAL_HOUR_HEIGHT}px"></div>`;
      linesHtml += `<div class="cal-hh-line" style="top:${h * CAL_HOUR_HEIGHT + CAL_HOUR_HEIGHT / 2}px"></div>`;
    }

    // Availability blocks
    const blocksHtml = (slotsByDay[dk] || []).map(({ pi, slot, inOverlap }) => {
      const c = colorForIndex(pi);
      const laneW = 100 / numPeople;
      const laneL = pi * laneW;

      const startMin = getMinuteOfDay(slot.start, tz);
      const endMin   = slot.end ? getMinuteOfDay(slot.end, tz) : startMin + 30;

      // Skip if outside visible range
      if (startMin >= CAL_END_HOUR * 60 || endMin <= CAL_START_HOUR * 60) return '';

      const clampStart = Math.max(startMin, CAL_START_HOUR * 60);
      const clampEnd   = Math.min(endMin,   CAL_END_HOUR   * 60);
      const top    = (clampStart - CAL_START_HOUR * 60) / 60 * CAL_HOUR_HEIGHT;
      const height = Math.max(8, (clampEnd - clampStart) / 60 * CAL_HOUR_HEIGHT - 2);

      return `<div
        class="cal-block${inOverlap ? ' in-overlap' : ''}"
        style="
          top:${top}px;
          height:${height}px;
          left:calc(${laneL}% + 2px);
          width:calc(${laneW}% - 4px);
          background:${c.bg};
          border-color:${inOverlap ? c.dot : c.border};
          color:${c.text};
        "
        title="${esc(fmtTime(slot.start, tz))}${inOverlap ? ' — works for everyone' : ''}"
      ><span class="cal-block-label">${fmtTime(slot.start, tz)}</span>${inOverlap ? '<span class="cal-block-check">✓</span>' : ''}</div>`;
    }).join('');

    const isOOR = pullStartDate && pullEndDate ? (dk < pullStartDate || dk >= pullEndDate) : false;
    return `<div class="cal-day-col${isOOR ? ' out-of-range' : ''}" style="height:${CAL_TOTAL_H}px">${linesHtml}${blocksHtml}</div>`;
  }).join('');

  const grid = document.getElementById('cal-grid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="cal-header-row">
      <div class="cal-corner"></div>
      ${headerHtml}
    </div>
    <div class="cal-body-row">
      <div class="cal-time-col" style="height:${CAL_TOTAL_H}px">${timeHtml}</div>
      <div class="cal-days-grid">${dayColsHtml}</div>
    </div>
  `;
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────

function getWeekDates(offset) {
  const today = new Date();
  const day   = today.getDay();
  const toMon = day === 0 ? -6 : 1 - day;
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + toMon + offset * 7 + i);
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${mo}-${dy}`);
  }
  return dates;
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getLocalDayKey(isoTime, timezone) {
  return new Date(isoTime).toLocaleDateString('en-CA', { timeZone: timezone });
}

function getMinuteOfDay(isoTime, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(isoTime));
  const h = parseInt(parts.find(p => p.type === 'hour').value)   % 24;
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

// ─── Copy to clipboard ────────────────────────────────────────────────────────

function copyOverlap() {
  if (!lastResults || !lastResults.overlap.length) return;

  const tz = displayTimezone;
  const byDay = groupByDay(lastResults.overlap, tz);

  const lines = ['Available for all participants:', ''];
  Object.entries(byDay).forEach(([label, slots]) => {
    lines.push(label);
    slots.forEach(s => lines.push(`  • ${fmtTimeRange(s.start, s.end, tz)}`));
    lines.push('');
  });

  navigator.clipboard.writeText(lines.join('\n').trim()).then(() => {
    const btn = document.getElementById('btn-copy');
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}

// ─── Results state machine ────────────────────────────────────────────────────

function setResultsState(state, errorMsg = '') {
  document.getElementById('results-loading').classList.add('hidden');
  document.getElementById('results-content').classList.add('hidden');
  document.getElementById('results-empty').classList.add('hidden');

  if (state === 'loading') {
    document.getElementById('results-loading').classList.remove('hidden');
  } else if (state === 'content') {
    document.getElementById('results-content').classList.remove('hidden');
  } else if (state === 'error') {
    const el = document.getElementById('results-empty');
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="results-empty-icon">⚠️</div>
      <p style="color:var(--error-text);font-weight:500">${esc(errorMsg)}</p>
      <p style="font-size:13px;margin-top:6px">Go back to Setup and check your links.</p>
    `;
  } else {
    document.getElementById('results-empty').classList.remove('hidden');
  }
}

// ─── Date / time helpers ──────────────────────────────────────────────────────

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

function fmtTime(iso, tz) {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtTimeRange(isoStart, isoEnd, tz) {
  return `${fmtTime(isoStart, tz)} – ${fmtTime(isoEnd, tz)}`;
}

function groupByDay(slots, tz) {
  const groups = {};
  slots.forEach(slot => {
    const label = new Date(slot.start).toLocaleDateString('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    if (!groups[label]) groups[label] = [];
    groups[label].push(slot);
  });
  return groups;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Wire up events ───────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('add-person-btn').addEventListener('click', () => addPerson());

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.days === 'custom') {
      customRangeMode = true;
      document.getElementById('custom-range').classList.remove('hidden');
    } else {
      customRangeMode = false;
      selectedDays = +btn.dataset.days;
      document.getElementById('custom-range').classList.add('hidden');
    }
  });
});

const customStartEl = document.getElementById('custom-start');
const customEndEl   = document.getElementById('custom-end');
if (customStartEl) {
  const todayStr = fmtDate(new Date());
  customStartEl.value = todayStr;
  customStartEl.min   = todayStr;
  customStartDate = todayStr;
  customStartEl.addEventListener('change', () => {
    customStartDate = customStartEl.value;
    if (customEndEl.value && customEndEl.value < customStartDate) {
      customEndEl.value = customStartDate;
      customEndDate = customStartDate;
    }
    customEndEl.min = customStartDate;
  });
}
if (customEndEl) {
  customEndEl.addEventListener('change', () => { customEndDate = customEndEl.value; });
}

document.getElementById('find-times-btn').addEventListener('click', findTimes);
document.getElementById('btn-copy').addEventListener('click', copyOverlap);

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.getElementById('cal-prev').addEventListener('click', () => {
  calendarWeekOffset--;
  if (lastResults) renderCalendar(lastResults);
});

document.getElementById('cal-next').addEventListener('click', () => {
  calendarWeekOffset++;
  if (lastResults) renderCalendar(lastResults);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

buildTimezoneSelector();
addPerson('', '');
addPerson('', '');
