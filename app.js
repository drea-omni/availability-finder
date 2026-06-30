'use strict';

// ─── Color palette for people ───────────────────────────────────────────────

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

// ─── State ───────────────────────────────────────────────────────────────────

let people = [];
let nextId = 1;
let selectedDays = 14;
let lastResults = null;

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

  // Events
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

// ─── Tabs ────────────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${name}`);
  });
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

async function findTimes() {
  const valid = people.filter(p => p.url.trim());
  if (valid.length === 0) {
    alert('Add at least one booking link to continue.');
    return;
  }

  switchTab('results');
  setResultsState('loading');

  const today = new Date();
  const endDay = new Date();
  endDay.setDate(endDay.getDate() + selectedDays);

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    const res = await fetch('/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        people: valid,
        startDate: fmtDate(today),
        endDate: fmtDate(endDay),
        timezone,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server error (${res.status})`);
    }

    lastResults = await res.json();
    renderResults(lastResults, timezone);
    setResultsState('content');

    // Update Results tab badge
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

function renderResults(data, timezone) {
  renderOverlap(data.overlap || [], timezone);
  renderIndividual(data.people || [], data.overlap || [], timezone);
}

function renderOverlap(overlap, timezone) {
  const countEl = document.getElementById('overlap-count');
  const container = document.getElementById('overlap-days');
  const copyBtn = document.getElementById('btn-copy');

  countEl.textContent = overlap.length;
  countEl.classList.toggle('hidden', overlap.length === 0);
  copyBtn.classList.toggle('hidden', overlap.length === 0);

  if (overlap.length === 0) {
    container.innerHTML = '<div class="no-overlap">No overlapping availability found in this date range. Try expanding the range or checking individual schedules below.</div>';
    return;
  }

  const byDay = groupByDay(overlap, timezone);
  container.innerHTML = Object.entries(byDay).map(([label, slots]) => `
    <div class="day-group">
      <div class="day-group-header">${label}</div>
      <div class="day-group-slots">
        ${slots.map(s => `<span class="slot-pill">${fmtTimeRange(s.start, s.end, timezone)}</span>`).join('')}
      </div>
    </div>
  `).join('');
}

function renderIndividual(peopleData, overlap, timezone) {
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
            <p class="no-slots-msg">No availability found in this range.</p>
          </div>
        </div>`;
    }

    const byDay = groupByDay(slots, timezone);

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
            >${fmtTime(s.start, timezone)}</span>`;
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

// ─── Copy to clipboard ───────────────────────────────────────────────────────

function copyOverlap() {
  if (!lastResults || !lastResults.overlap.length) return;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
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

// ─── Results state machine ───────────────────────────────────────────────────

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

// ─── Date / time helpers ─────────────────────────────────────────────────────

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

// ─── Utils ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Wire up events ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('add-person-btn').addEventListener('click', () => addPerson());

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedDays = +btn.dataset.days;
  });
});

document.getElementById('find-times-btn').addEventListener('click', findTimes);
document.getElementById('btn-copy').addEventListener('click', copyOverlap);

// ─── Init ────────────────────────────────────────────────────────────────────

addPerson('', '');
addPerson('', '');
