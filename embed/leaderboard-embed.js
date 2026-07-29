// ═══════════════════════════════════════════════════════════
//  PuzzleBoard — Leaderboard-only embed
//  Read-only: fetches board_state from Supabase, renders the
//  leaderboard grid only. No PIN, no admin, no writes.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://fpyoigjrwtodhztzqxro.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZweW9pZ2pyd3RvZGh6dHpxeHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDA5NTcsImV4cCI6MjA5NjUxNjk1N30.LXPIG4UMAKclCcHkOFKyVXe9P1FytvlJCBH0z_UOWFA';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // re-fetch every 5 minutes

let S = { entries: [], members: [] };
let embedSort   = 'received';
let embedYear   = new Date().getFullYear();
let _quarterPopoverOpen = false;

// Default to the current quarter, e.g. 'quarter:2026-Q3'
function currentQuarterValue() {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `quarter:${now.getFullYear()}-Q${q}`;
}
let embedPeriod = currentQuarterValue();

// ── Fetch (read-only — GET only, never PATCH) ────────────────
async function fetchBoardState() {
  const TIMEOUT_MS = 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/board_state?id=eq.1&select=data`,
      { headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        },
        signal: controller.signal
      }
    );
    clearTimeout(timer);
    if (!r.ok) throw new Error(r.status);
    const rows = await r.json();
    if (rows.length && rows[0].data) {
      const parsed = JSON.parse(rows[0].data);
      S = { entries: parsed.entries || [], members: parsed.members || [] };
      return true;
    }
    return false;
  } catch (e) {
    clearTimeout(timer);
    console.warn('[PuzzleBoard embed] fetch failed:', e.message);
    return false;
  }
}

// ── Period filter (same logic as main app) ───────────────────
function filterByPeriod(entries) {
  if (embedPeriod === 'all') return entries;

  if (embedPeriod === '7d' || embedPeriod === '30d') {
    const days   = embedPeriod === '7d' ? 7 : 30;
    const cutoff = new Date(Date.now() - days * 86400000);
    return entries.filter(e => new Date(e.date) >= cutoff);
  }

  if (embedPeriod.startsWith('quarter:')) {
    const [year, qStr] = embedPeriod.slice(8).split('-');
    const q = parseInt(qStr.slice(1));
    const startMonth = (q - 1) * 3;
    const start = new Date(parseInt(year), startMonth, 1);
    const end   = new Date(parseInt(year), startMonth + 3, 1);
    return entries.filter(e => { const d = new Date(e.date); return d >= start && d < end; });
  }

  return entries;
}

function periodLabel() {
  if (embedPeriod === '7d')  return 'Last 7 Days';
  if (embedPeriod === '30d') return 'Last 30 Days';
  if (embedPeriod === 'all') return 'All Time';
  if (embedPeriod.startsWith('quarter:')) {
    const [year, qStr] = embedPeriod.slice(8).split('-');
    return `${qStr} ${year}`;
  }
  return embedPeriod;
}

// ── Aggregation (mirrors main app's aggregate/applyLimit-free version) ──
// Note: daily send-limit capping is intentionally omitted here — this is a
// display-only summary, not the source of truth for enforcement.
function aggregate(entries) {
  const people = {};
  const ensurePerson = name => { if (!people[name]) people[name] = { name, sent: 0, received: 0 }; };
  S.members.forEach(m => ensurePerson(m.name));

  for (const e of entries) {
    if (e.isBonus) {
      ensurePerson(e.recipient);
      people[e.recipient].received += e.count;
      continue;
    }
    ensurePerson(e.sender);
    ensurePerson(e.recipient);
    people[e.sender].sent        += e.count;
    people[e.recipient].received += e.count;
  }
  for (const p of Object.values(people)) p.total = p.sent + p.received;
  return Object.values(people);
}

function sortPeople(people) {
  return [...people].sort((a, b) => {
    if (embedSort === 'sent') return b.sent - a.sent;
    return b.received - a.received;
  });
}

// ── Controls ──────────────────────────────────────────────────
function setEmbedPeriod(val, btn) {
  closeQuarterPopover();
  embedPeriod = val;
  document.querySelectorAll('#lb-period-group .pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderEmbedLeaderboard();
}

function syncQuarterPillLabel() {
  const btn = document.getElementById('ep-quarter');
  if (!btn) return;
  if (embedPeriod.startsWith('quarter:')) {
    btn.textContent = periodLabel() + ' ▾';
    document.querySelectorAll('#lb-period-group .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  } else {
    btn.textContent = 'Quarter ▾';
  }
}

function toggleQuarterPopover() {
  _quarterPopoverOpen = !_quarterPopoverOpen;
  const pop = document.getElementById('ep-quarter-popover');
  if (_quarterPopoverOpen) {
    // If current selection is a quarter, jump the picker to that year
    if (embedPeriod.startsWith('quarter:')) embedYear = parseInt(embedPeriod.slice(8).split('-')[0]);
    renderQuarterGrid();
    pop.classList.add('open');
  } else {
    pop.classList.remove('open');
  }
}

function closeQuarterPopover() {
  _quarterPopoverOpen = false;
  const pop = document.getElementById('ep-quarter-popover');
  if (pop) pop.classList.remove('open');
}

function shiftEmbedYear(delta) {
  embedYear = Math.max(2020, Math.min(new Date().getFullYear(), embedYear + delta));
  renderQuarterGrid();
}

function renderQuarterGrid() {
  document.getElementById('ep-year-label').textContent = embedYear;
  const now = new Date();
  const nowYM = now.getFullYear() * 100 + (now.getMonth() + 1);
  const grid = document.getElementById('ep-quarter-grid');
  grid.innerHTML = ['Q1', 'Q2', 'Q3', 'Q4'].map((q, i) => {
    const val = `quarter:${embedYear}-${q}`;
    const isActive = embedPeriod === val;
    const qEndYM = embedYear * 100 + ((i + 1) * 3);
    const isFuture = qEndYM > nowYM;
    return `<button class="popover-item ${isActive ? 'active' : ''}" ${isFuture ? 'disabled' : ''}
      onclick="selectEmbedQuarter('${val}')">${q}</button>`;
  }).join('');
}

function selectEmbedQuarter(val) {
  embedPeriod = val;
  closeQuarterPopover();
  syncQuarterPillLabel();
  renderEmbedLeaderboard();
}

// Close popover on outside click
document.addEventListener('click', e => {
  if (_quarterPopoverOpen && !e.target.closest('#lb-period-group')) closeQuarterPopover();
});

function setEmbedSort(val, btn) {
  embedSort = val;
  document.querySelectorAll('#lb-sort-group .pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderEmbedLeaderboard();
}

// ── Render ────────────────────────────────────────────────────
function renderEmbedLeaderboard() {
  const filtered = filterByPeriod(S.entries);
  const people   = aggregate(filtered);
  const ranked   = sortPeople(people);

  document.getElementById('lb-period-display').textContent = `— ${periodLabel()}`;

  const grid = document.getElementById('lb-embed-grid');
  const searchQuery = (document.getElementById('lb-embed-search').value || '').toLowerCase().trim();

  if (ranked.length === 0 || ranked.every(p => p.total === 0)) {
    grid.innerHTML = `<div class="lb-embed-empty">
      <div class="lb-embed-empty-icon">🧩</div>
      <div>No recognitions logged for this period yet.</div>
    </div>`;
    return;
  }

  const visible = searchQuery
    ? ranked.filter(p => p.name.toLowerCase().includes(searchQuery))
    : ranked.slice(0, 15);

  if (visible.length === 0) {
    grid.innerHTML = `<div class="lb-embed-empty">No results for "${searchQuery}"</div>`;
    return;
  }

  const maxSent = Math.max(...ranked.map(p => p.sent), 1);
  const maxRecv = Math.max(...ranked.map(p => p.received), 1);

  grid.innerHTML = visible.map(p => {
    const globalRank = ranked.indexOf(p);
    const rankLabel  = globalRank === 0 ? '🥇' : globalRank === 1 ? '🥈' : globalRank === 2 ? '🥉' : `#${globalRank + 1}`;
    const rankClass  = globalRank === 0 ? 'rank-1' : globalRank === 1 ? 'rank-2' : globalRank === 2 ? 'rank-3' : '';
    const sortVal    = embedSort === 'sent' ? p.sent : p.received;
    const sortLbl    = embedSort === 'sent' ? 'sent' : 'recv';
    const sortClass  = embedSort === 'sent' ? 'sent' : 'recv';

    return `<div class="lb-embed-card ${rankClass}">
      <div class="lb-embed-rank">${rankLabel}</div>
      <div class="lb-embed-name-block">
        <div class="lb-embed-name">${p.name}</div>
        <div class="lb-embed-meta">🟢 ${p.sent} sent · 🔴 ${p.received} received</div>
      </div>
      <div class="lb-embed-bars">
        <div class="lb-embed-bar-row">
          <div class="lb-embed-bar-lbl">SENT</div>
          <div class="lb-embed-bar-track"><div class="lb-embed-bar-fill sent" style="width:${Math.round(p.sent / maxSent * 100)}%"></div></div>
          <div class="lb-embed-bar-val">${p.sent}</div>
        </div>
        <div class="lb-embed-bar-row">
          <div class="lb-embed-bar-lbl">RECV</div>
          <div class="lb-embed-bar-track"><div class="lb-embed-bar-fill recv" style="width:${Math.round(p.received / maxRecv * 100)}%"></div></div>
          <div class="lb-embed-bar-val">${p.received}</div>
        </div>
      </div>
      <div class="lb-embed-count">
        <div class="lb-embed-count-big ${sortClass}">${sortVal}</div>
        <div class="lb-embed-count-lbl">${sortLbl}</div>
      </div>
    </div>`;
  }).join('');
}

function updateFooter(ok) {
  const el = document.getElementById('lb-embed-updated');
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  el.textContent = ok ? `Updated ${time}` : `⚠ Couldn't refresh · showing last data`;
}

// ── Init ──────────────────────────────────────────────────────
(async () => {
  syncQuarterPillLabel();
  const ok = await fetchBoardState();
  updateFooter(ok);
  renderEmbedLeaderboard();
  setInterval(async () => {
    const ok2 = await fetchBoardState();
    updateFooter(ok2);
    renderEmbedLeaderboard();
  }, REFRESH_INTERVAL_MS);
})();
