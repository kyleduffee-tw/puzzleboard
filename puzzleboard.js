// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
const DEFAULTS = {
  entries: [],
  members: [],       // { name, title, birthday:'MM-DD', hireDate:'YYYY-MM-DD', addedAt }
  channel: 'kudos',
  pin: '123456',
  limitEnabled: false,
  limitPerDay: 5,
  myName: '',
  period: '7d',        // runtime period — reset to defaultPeriod on each load
  pickerYear: new Date().getFullYear(),
  defaultPeriod: '7d', // '7d' | '30d' | 'month:YYYY-MM' | 'quarter:YYYY-Q#' | 'all'
  defaultSort: 'received', // 'total' | 'sent' | 'received'
  sort: 'received',
  birthdayEnabled: true,
  birthdayBonus: 5,
  anniversaryEnabled: true,
  anniversaryBonus: 3,
  milestoneYears: [1,5,10,15,20],
  milestoneBonus: 10,
  awardedMilestones: [],              // [{ name, type, year, date }] — dedup log
  archives: [],
  importedMessageIds: [],  // Teams Message IDs already imported via spreadsheet
  cacheTimestamp: 0         // epoch ms of last Supabase sync
};

let S = { ...DEFAULTS };
let currentPin = '';

// ── PIN hashing & lockout ────────────────────────────────
const PIN_MAX_ATTEMPTS = 3;
const PIN_LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes
const PIN_STORE_KEY    = 'pb_pin_lockout';

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function getLockoutState() {
  try { return JSON.parse(localStorage.getItem(PIN_STORE_KEY)) || { attempts: 0, lockedUntil: 0 }; }
  catch(e) { return { attempts: 0, lockedUntil: 0 }; }
}

function setLockoutState(state) {
  try { localStorage.setItem(PIN_STORE_KEY, JSON.stringify(state)); } catch(e) {}
}

function clearLockout() {
  try { localStorage.removeItem(PIN_STORE_KEY); } catch(e) {}
}

let _lockoutInterval = null;

function checkLockout() {
  const state = getLockoutState();
  const errEl = document.getElementById('pinError');
  if (state.lockedUntil > Date.now()) {
    // Still locked — show countdown
    const rem = Math.ceil((state.lockedUntil - Date.now()) / 1000);
    const mins = Math.floor(rem / 60);
    const secs = rem % 60;
    if (errEl) errEl.textContent = `Too many attempts. Try again in ${mins}:${String(secs).padStart(2,'0')}`;
    // Disable keypad
    document.querySelectorAll('.pin-btn').forEach(b => b.disabled = true);
    if (!_lockoutInterval) {
      _lockoutInterval = setInterval(() => {
        if (getLockoutState().lockedUntil <= Date.now()) {
          clearInterval(_lockoutInterval);
          _lockoutInterval = null;
          document.querySelectorAll('.pin-btn').forEach(b => b.disabled = false);
          if (errEl) errEl.textContent = '';
        } else {
          checkLockout();
        }
      }, 1000);
    }
    return true; // is locked
  }
  document.querySelectorAll('.pin-btn').forEach(b => b.disabled = false);
  return false; // not locked
}
let _storageReady = false;
let _supabaseOk      = false;
let _lastRefreshFailed = false;

// ── Supabase config ──────────────────────────────────────────
const SUPABASE_URL = 'https://fpyoigjrwtodhztzqxro.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZweW9pZ2pyd3RvZGh6dHpxeHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDA5NTcsImV4cCI6MjA5NjUxNjk1N30.LXPIG4UMAKclCcHkOFKyVXe9P1FytvlJCBH0z_UOWFA';
const STORE_KEY    = 'puzzleboard-state'; // localStorage fallback key

async function storageGet() {
  const MAX_RETRIES = 2;
  const TIMEOUT_MS  = 5000; // give up after 5 seconds per attempt
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
      if (!r.ok) {
        const body = await r.text();
        console.error('[PuzzleBoard] Supabase GET failed:', r.status, body);
        throw new Error(r.status);
      }
      const rows = await r.json();
      console.log('[PuzzleBoard] Supabase GET ok, rows:', rows.length);
      _supabaseOk = true;
      return { data: rows.length ? rows[0].data : null, fromSupabase: true };
    } catch(e) {
      clearTimeout(timer);
      console.warn(`[PuzzleBoard] Supabase GET error (attempt ${attempt}/${MAX_RETRIES}):`, e.message);
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 800));
    }
  }
  console.error('[PuzzleBoard] Supabase GET failed after all retries');
  _supabaseOk = false;
  return { data: null, fromSupabase: false };
}

async function storageSet(value) {
  const setController = new AbortController();
  const setTimer = setTimeout(() => setController.abort(), 5000);
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/board_state?id=eq.1`,
      { method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        signal: setController.signal,
        body: JSON.stringify({ data: value })
      }
    );
    if (!r.ok) throw new Error(r.status);
    clearTimeout(setTimer);
    _supabaseOk = true;
  } catch(e) {
    clearTimeout(setTimer);
    _supabaseOk = false;
    try { localStorage.setItem(STORE_KEY, value); } catch(e2) {}
  }
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function setRefreshSpinning(spinning) {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  btn.disabled = spinning;
  btn.style.transition = spinning ? 'none' : 'all 0.15s';
  btn.style.animation = spinning ? 'spin 0.8s linear infinite' : 'none';
}

async function loadState(forceRefresh = false) {
  // Step 1: load from localStorage immediately so board shows cached data fast
  try {
    const cached = localStorage.getItem(STORE_KEY);
    if (cached && cached !== '{}') {
      S = { ...DEFAULTS, ...JSON.parse(cached) };
      _storageReady = true;
      renderUser(); // show cached data right away
    }
  } catch(e) {}

  // Step 2: skip Supabase fetch if cache is fresh enough (unless forced)
  const cacheAge = Date.now() - (S.cacheTimestamp || 0);
  if (!forceRefresh && cacheAge < CACHE_TTL_MS && S.cacheTimestamp > 0) {
    console.log('[PuzzleBoard] cache fresh (' + Math.round(cacheAge/1000) + 's old), skipping Supabase fetch');
    _storageReady = true;
    requestAnimationFrame(updateStorageStatus);
    renderUser();
    updateLastUpdatedLabel();
    return true; // cache is fresh, treat as success
  }

  // Step 3: fetch from Supabase and update cache
  let supabaseOk = false;
  const hadCachedData = S.cacheTimestamp > 0; // did we load anything from localStorage?
  try {
    const result = await storageGet();
    const raw = result?.fromSupabase ? result.data : null;
    supabaseOk = result?.fromSupabase === true;
    if (supabaseOk && raw && raw !== '{}') {
      S = { ...DEFAULTS, ...JSON.parse(raw) };
      S.cacheTimestamp = Date.now();
      // Keep localStorage in sync as a local cache
      try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch(e) {}
    }
  } catch(e) {}
  // Mark as failed if: manual refresh failed, OR fresh load with no cache failed
  _lastRefreshFailed = !supabaseOk && (forceRefresh || !hadCachedData);
  _storageReady = true;
  requestAnimationFrame(updateStorageStatus);
  renderUser();
  updateLastUpdatedLabel();
  // Show modal whenever Supabase fails — manual refresh or fresh load with no cache
  if (!supabaseOk && (forceRefresh || !hadCachedData)) showSyncErrorModal(hadCachedData);
  return supabaseOk;
}

function updateLastUpdatedLabel() {
  const el = document.getElementById('last-updated-label');
  if (!el) return;
  // Show failure flag alongside the last successful sync time
  if (_lastRefreshFailed) {
    el.style.color = 'var(--danger)';
    if (S.cacheTimestamp) {
      const ageMs   = Date.now() - S.cacheTimestamp;
      const ageMins = Math.floor(ageMs / 60000);
      const ageHrs  = Math.floor(ageMins / 60);
      let ago;
      if (ageMins < 1)       ago = 'just now';
      else if (ageMins < 60) ago = ageMins + 'm ago';
      else if (ageHrs < 24)  ago = ageHrs + 'h ' + (ageMins % 60) + 'm ago';
      else                   ago = Math.floor(ageHrs / 24) + 'd ago';
      el.textContent = '⚠ sync failed · last updated ' + ago;
    } else {
      el.textContent = '⚠ sync failed';
    }
    return;
  }
  el.style.color = 'var(--muted)';
  // Use the persisted cacheTimestamp from Supabase, not the local load time
  const ts = S.cacheTimestamp || 0;
  if (!ts) { el.textContent = ''; return; }
  const ageMs   = Date.now() - ts;
  const ageMins = Math.floor(ageMs / 60000);
  const ageHrs  = Math.floor(ageMins / 60);
  let label;
  if (ageMins < 1)       label = 'Just updated';
  else if (ageMins < 60) label = ageMins + 'm ago';
  else if (ageHrs < 24)  label = ageHrs + 'h ' + (ageMins % 60) + 'm ago';
  else                   label = Math.floor(ageHrs / 24) + 'd ago';
  el.textContent = label;
}

// Keep the label ticking every minute so it stays accurate without a refresh
setInterval(updateLastUpdatedLabel, 60000);

// Close searchable dropdowns when clicking outside
document.addEventListener('click', e => {
  ['pb-recipient', 'al-sender', 'al-recipient'].forEach(id => {
    const dd = document.getElementById(`${id}-dropdown`);
    const search = document.getElementById(`${id}-search`);
    if (dd && !dd.contains(e.target) && e.target !== search) {
      dd.style.display = 'none';
    }
  });
});

function showSyncErrorModal(hasCachedData = true) {
  const existing = document.getElementById('syncErrorModal');
  if (existing) existing.remove();

  const subMsg = hasCachedData
    ? 'PuzzleBoard couldn\'t reach its data server. You\'re viewing your last cached data — this usually resolves on its own, try ↻ again in a moment.'
    : 'PuzzleBoard couldn\'t reach its data server. This usually resolves on its own — try ↻ again in a moment.';

  const btn = hasCachedData
    ? `<button onclick="document.getElementById('syncErrorModal').remove()" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px 32px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;">OK</button>`
    : `<button onclick="document.getElementById('syncErrorModal').remove();forceRefresh();" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px 32px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;">↻ Reload</button>
       <button onclick="document.getElementById('syncErrorModal').remove()" style="background:none;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;margin-left:8px;">Try Later</button>`;

  const modal = document.createElement('div');
  modal.id = 'syncErrorModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px 28px;max-width:340px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
      <img src="mascot_sad.png" alt="" style="width:72px;height:auto;margin-bottom:12px;">
      <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:8px;">Couldn't reach the server</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:24px;">${subMsg}</div>
      <div style="display:flex;justify-content:center;gap:8px;">${btn}</div>
    </div>
  `;
  document.body.appendChild(modal);
  // Only allow click-outside dismiss when there's cached data — otherwise user must make a choice
  if (hasCachedData) modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function forceRefresh() {
  console.log('[PuzzleBoard] manual refresh triggered');
  const overlay = document.getElementById('loading-overlay');
  const overlayText = document.getElementById('loading-overlay-text');
  const overlaySpinner = document.getElementById('loading-overlay-spinner');
  if (overlay) { overlay.style.display = 'flex'; }
  if (overlayText) overlayText.textContent = 'Refreshing data…';
  if (overlaySpinner) overlaySpinner.style.display = '';
  setRefreshSpinning(true);

  const ok = await loadState(true);

  setRefreshSpinning(false);
  if (overlay) { overlay.style.display = 'none'; }
  if (overlayText) overlayText.textContent = 'Refreshing data…';
  if (overlaySpinner) overlaySpinner.style.display = '';
  if (btn) btn.disabled = false;
}

function updateStorageStatus() {
  const dot   = document.getElementById('storage-dot');
  const label = document.getElementById('storage-label');
  if (!dot || !label) return;
  const count = S.entries.length;
  const memberCount = S.members.length;
  if (_supabaseOk) {
    dot.style.background = 'var(--accent3)';
    label.innerHTML = `<strong style="color:var(--accent3)">Supabase connected</strong> — shared persistent storage · ${count} entr${count!==1?'ies':'y'}, ${memberCount} member${memberCount!==1?'s':''}`;
  } else if (typeof localStorage !== 'undefined') {
    dot.style.background = 'var(--warn)';
    label.innerHTML = `<strong style="color:var(--warn)">localStorage fallback</strong> — Supabase unreachable, data is local only · ${count} entr${count!==1?'ies':'y'}`;
  } else {
    dot.style.background = 'var(--danger)';
    label.innerHTML = `<strong style="color:var(--danger)">Session only</strong> — data will be lost when you close this tab. Export JSON to save.`;
  }
}

async function save() {
  try {
    S.cacheTimestamp = Date.now();
    const data = JSON.stringify(S);
    await storageSet(data);
    try { localStorage.setItem(STORE_KEY, data); } catch(e) {}
  } catch(e) {}
}

function today() {
  // Always use Central Time (America/Chicago) so the daily limit resets
  // at midnight CT regardless of where the user's browser is located.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  // en-CA locale produces YYYY-MM-DD format natively
}

// All known Teams representations of the puzzle piece emoji
// Teams desktop/web/mobile can produce any of these depending on client + OS
const PUZZLE_RE = /🧩/gu;

// Normalise a raw pasted string: replace all Teams text-fallback variants
// with the actual Unicode puzzle piece before counting.
// This runs on both plain text AND on raw HTML clipboard content (from the
// paste event interceptor below), so it must handle <img> tags before
// stripping all other HTML.
function normalisePuzzles(text) {
  return text
    // ── Unicode / HTML entity forms ──────────────────────────
    .replace(/&#129513;/gi, '🧩')
    .replace(/&#x1F9E9;/gi, '🧩')
    // ── Collapse Teams @mention spans BEFORE stripping tags ──
    // Clipboard format: <span itemtype=".../Mention">Word</span>
    // Power Automate format: <at id="0">Word</at>
    // Both split names across multiple tags joined by &nbsp;
    .replace(/<span[^>]*itemtype=["']http:\/\/schema\.skype\.com\/Mention["'][^>]*>([^<]*)<\/span>/gi, '__MSTART__$1__MEND__')
    .replace(/<at\b[^>]*>([^<]*)<\/at>/gi, '__MSTART__$1__MEND__')
    .replace(/(__MEND__)(?:&nbsp;|\s)*(__MSTART__)/gi, ' ')
    .replace(/__MSTART__([^_])/g, '@$1')
    .replace(/__MEND__/g, '')
    // ── Teams clipboard HTML: <img> tags with various alt texts ──
    // Power Automate uses <emoji alt='🧩'></emoji> — handle before stripping tags
    .replace(/<emoji\b[^>]*\balt=["'](?:🧩|puzzle[\s_]piece|jigsaw)["'][^>]*>(?:<\/emoji>)?/gi, '🧩')
    .replace(/<emoji\b[^>]*\btitle=["'](?:puzzle piece|jigsaw)["'][^>]*>(?:<\/emoji>)?/gi, '🧩')
    // Teams desktop/web copies emoji as <img> — catch every known alt variant
    // (attribute order varies, so we match alt= anywhere inside the tag)
    .replace(/<img\b[^>]*\balt=["'](?:🧩|puzzle[\s_]piece|jigsaw|Puzzle Piece|Jigsaw)["'][^>]*\/?>/gi, '🧩')
    // Teams sometimes encodes the codepoint in the src/title instead of alt
    .replace(/<img\b[^>]*\btitle=["'](?:puzzle[\s_]piece|jigsaw)["'][^>]*\/?>/gi, '🧩')
    // ── Slack/Teams colon-shortcode variants ─────────────────
    .replace(/:puzzle_piece:/gi, '🧩')
    .replace(/:jigsaw:/gi, '🧩')
    .replace(/:puzzle:/gi, '🧩')
    // ── Bracketed / parenthesised text fallbacks ─────────────
    .replace(/\[puzzle piece\]/gi, '🧩')
    .replace(/\[puzzle\]/gi, '🧩')
    .replace(/\[jigsaw\]/gi, '🧩')
    .replace(/\(puzzle piece\)/gi, '🧩')
    .replace(/\(puzzle\)/gi, '🧩')
    // ── Standalone phrase (avoid false-matching "great puzzle game") ──
    .replace(/\bpuzzle piece\b/gi, '🧩')
    // ── Convert block-level tags to newlines BEFORE stripping ──
    // Teams wraps each message in <p>...</p>; without this they
    // collapse into one line and the parser can't split them.
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    // ── Decode &nbsp; so it doesn't end up as literal text ───
    .replace(/&nbsp;/gi, ' ')
    // ── Strip any remaining HTML tags ────────────────────────
    .replace(/<[^>]+>/g, ' ')
    // ── Collapse multiple spaces ──────────────────────────────
    .replace(/ {2,}/g, ' ')
    // ── Collapse excess blank lines ───────────────────────────
    .replace(/\n{3,}/g, '\n\n');
}

// ── Fingerprinting + dedup ──────────────────────────────────
// A fingerprint is a short hash of sender|recipient|date|noteSnippet.
// It lets us skip re-importing the same parsed message line.
function makeFp(sender, recipient, date, note) {
  const raw = `${sender}|${recipient}|${date}|${(note||'').slice(0,40)}`;
  // FNV-1a 32-bit — fast, no crypto needed
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function buildFpSet() {
  const set = new Set();
  S.entries.forEach(e => { if (e.fp) set.add(e.fp); });
  return set;
}

// Deduplicate a batch of parsed entries against existing records.
// Returns { added: [...], skipped: number }
function dedupEntries(parsed) {
  const existing = buildFpSet();
  const added = [];
  let skipped = 0;
  for (const e of parsed) {
    const fp = e.fp || makeFp(e.sender, e.recipient, e.date, e.note);
    if (existing.has(fp)) { skipped++; continue; }
    existing.add(fp); // prevent dupes within the same paste batch too
    added.push({ ...e, fp });
  }
  return { added, skipped };
}

// Backfill fp onto any legacy entries that lack one (safe, idempotent)
function backfillFps() {
  let changed = false;
  S.entries = S.entries.map(e => {
    if (!e.fp) { changed = true; return { ...e, fp: makeFp(e.sender, e.recipient, e.date, e.note) }; }
    return e;
  });
  if (changed) save();
}

// ═══════════════════════════════════════════════════════════
//  PIN LOCK
// ═══════════════════════════════════════════════════════════
function showLock() {
  checkLockout(); // restore lockout state if returning to lock screen
  currentPin = '';
  updatePinDots();
  document.getElementById('pinError').textContent = '';
  document.getElementById('lockScreen').style.display = 'flex';
}

function hideLock() {
  document.getElementById('lockScreen').style.display = 'none';
}

function pinPress(d) {
  if (currentPin.length >= 6) return;
  currentPin += d;
  updatePinDots();
  if (currentPin.length === 6) setTimeout(checkPin, 120);
}

function pinBack() { currentPin = currentPin.slice(0,-1); updatePinDots(); }
function pinClear() { currentPin = ''; updatePinDots(); }

// Keyboard support for PIN entry
document.addEventListener('keydown', function(e) {
  const lock = document.getElementById('lockScreen');
  if (!lock || lock.style.display === 'none') return;
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); pinPress(e.key); }
  else if (e.key === 'Backspace')    { e.preventDefault(); pinBack(); }
  else if (e.key === 'Escape')       { e.preventDefault(); pinClear(); }
  else if (e.key === 'Enter')        { e.preventDefault(); if (currentPin.length > 0) checkPin(); }
});

function updatePinDots() {
  for (let i=0;i<6;i++) {
    document.getElementById('d'+i).classList.toggle('filled', i < currentPin.length);
  }
}

async function checkPin() {
  if (checkLockout()) { currentPin = ''; updatePinDots(); return; }
  const entered = await hashPin(currentPin);
  const stored  = S.pin.length === 64 ? S.pin : await hashPin(S.pin); // handle plain text legacy PINs
  if (entered === stored) {
    clearLockout();
    hideLock();
    switchToAdmin();
  } else {
    const state = getLockoutState();
    state.attempts = (state.attempts || 0) + 1;
    const remaining = PIN_MAX_ATTEMPTS - state.attempts;
    if (state.attempts >= PIN_MAX_ATTEMPTS) {
      state.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
      state.attempts = 0;
      setLockoutState(state);
      checkLockout();
    } else {
      setLockoutState(state);
      const errEl = document.getElementById('pinError');
      if (errEl) {
        errEl.textContent = `Incorrect PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`;
        errEl.style.animation = 'none';
        void errEl.offsetWidth;
        errEl.style.animation = '';
      }
    }
    currentPin = '';
    updatePinDots();
  }
}

// ═══════════════════════════════════════════════════════════
//  VIEW SWITCHING
// ═══════════════════════════════════════════════════════════
function switchToAdmin() {
  document.getElementById('userView').classList.remove('active');
  document.getElementById('adminView').classList.add('active');
  renderAdmin();
}

function switchToUser() {
  document.getElementById('adminView').classList.remove('active');
  document.getElementById('userView').classList.add('active');
  renderUser();
}

// ═══════════════════════════════════════════════════════════
//  FILTERING + AGGREGATION
// ═══════════════════════════════════════════════════════════
function filterByPeriod(entries) {
  const p = S.period || '7d';
  if (p === 'all') return entries;

  if (p === '7d' || p === '30d') {
    const days   = p === '7d' ? 7 : 30;
    const cutoff = new Date(Date.now() - days * 86400000);
    return entries.filter(e => new Date(e.date) >= cutoff);
  }

  if (p.startsWith('month:')) {
    // 'month:YYYY-MM'
    const [year, month] = p.slice(6).split('-').map(Number);
    const start = new Date(year, month - 1, 1);
    const end   = new Date(year, month, 1); // exclusive
    return entries.filter(e => { const d = new Date(e.date); return d >= start && d < end; });
  }

  if (p.startsWith('quarter:')) {
    // 'quarter:YYYY-Q#'  e.g. 'quarter:2025-Q2'
    const [year, qStr] = p.slice(8).split('-');
    const q = parseInt(qStr.slice(1)); // 1-4
    const startMonth = (q - 1) * 3; // 0-indexed
    const start = new Date(parseInt(year), startMonth, 1);
    const end   = new Date(parseInt(year), startMonth + 3, 1); // exclusive
    return entries.filter(e => { const d = new Date(e.date); return d >= start && d < end; });
  }

  return entries;
}

// Human-readable label for the current period
function periodLabel() {
  const p = S.period || '7d';
  if (p === '7d')   return 'Last 7 Days';
  if (p === '30d')  return 'Last 30 Days';
  if (p === 'all')  return 'All Time';
  if (p.startsWith('month:')) {
    const [year, month] = p.slice(6).split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[month-1]} ${year}`;
  }
  if (p.startsWith('quarter:')) {
    const [year, qStr] = p.slice(8).split('-');
    return `${qStr} ${year}`;
  }
  return p;
}

function applyLimit(entries) {
  if (!S.limitEnabled) return entries;
  const used = {};
  const out  = [];
  const sorted = [...entries].sort((a,b)=>a.date.localeCompare(b.date));
  for (const e of sorted) {
    // Bonus entries from PuzzleBoard are never capped — they always count in full
    if (e.isBonus) { out.push(e); continue; }
    const key = `${e.sender}||${e.date}`;
    used[key] = used[key] || 0;
    const rem = S.limitPerDay - used[key];
    if (rem <= 0) continue;
    const allowed = Math.min(e.count, rem);
    used[key] += allowed;
    out.push({...e, count: allowed});
  }
  return out;
}

// Returns a Set of fps that are over the daily send limit
function buildOverLimitSet() {
  if (!S.limitEnabled) return new Set();
  const used = {};
  const over = new Set();
  const sorted = [...S.entries].filter(e => !e.isBonus).sort((a,b) => a.date.localeCompare(b.date));
  for (const e of sorted) {
    const key = `${e.sender}||${e.date}`;
    used[key] = used[key] || 0;
    const rem = S.limitPerDay - used[key];
    if (rem <= 0) {
      over.add(e.fp);
    } else {
      used[key] += Math.min(e.count, rem);
      if (e.count > rem) over.add(e.fp); // partially over
    }
  }
  return over;
}

function aggregate(entries) {
  const capped = applyLimit(entries);
  const people = {};
  const ensurePerson = name => {
    if (!people[name]) people[name] = { name, sent:0, received:0 };
  };

  // Ensure all registered members appear even with 0s
  S.members.forEach(m => ensurePerson(m.name));

  for (const e of capped) {
    // Bonus entries: only credit the recipient — don't add PuzzleBoard to the leaderboard
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

function senderTodayRaw(name, date) {
  // Use capped entries so the remaining count reflects the actual limit correctly
  const todayEntries = S.entries.filter(e => e.sender === name && e.date === date);
  const capped = applyLimit(todayEntries);
  return capped.reduce((s,e) => s+e.count, 0);
}

function sortPeople(people) {
  return [...people].sort((a,b) => {
    if (S.sort==='sent')     return b.sent     - a.sent;
    if (S.sort==='received') return b.received - a.received;
    return b.total - a.total;
  });
}

// ═══════════════════════════════════════════════════════════
//  RENDER — USER VIEW
// ═══════════════════════════════════════════════════════════
function renderUser() {
  const filtered  = filterByPeriod(S.entries);
  const people    = aggregate(filtered);
  const ranked    = sortPeople(people);
  const capped    = applyLimit(filtered);
  const totalGiven = capped.reduce((s,e)=>s+e.count,0);

  // Header
  document.getElementById('u-channel').textContent = S.channel;
  document.getElementById('u-name-btn').textContent = S.myName || 'Set My Name';

  // Stats
  const topSender   = [...people].sort((a,b)=>b.sent-a.sent)[0];
  const topRecv     = [...people].sort((a,b)=>b.received-a.received)[0];
  document.getElementById('u-stat-total').textContent      = totalGiven || '—';
  document.getElementById('u-stat-topsender').textContent  = topSender?.name?.split(' ')[0] || '—';
  document.getElementById('u-stat-toprecv').textContent    = topRecv?.name?.split(' ')[0] || '—';
  document.getElementById('u-stat-members').textContent    = S.members.length || people.length || '—';
  document.getElementById('u-stat-limit').textContent      = S.limitEnabled ? `${S.limitPerDay}` : '∞';

  // My banner
  const myBanner = document.getElementById('u-my-banner');
  if (S.myName) {
    const me = people.find(p => p.name === S.myName) || { sent:0, received:0, total:0 };
    const myRankPos  = ranked.findIndex(p => p.name === S.myName) + 1;
    const rankTotal  = ranked.length;
    const rankMedal  = myRankPos === 1 ? '🥇' : myRankPos === 2 ? '🥈' : myRankPos === 3 ? '🥉' : null;
    const rankDisplay = myRankPos > 0
      ? (rankMedal
          ? `<div class="my-stat-val" style="font-size:22px;line-height:1.1;">${rankMedal} #${myRankPos}</div><div class="my-stat-lbl">Rank · of ${rankTotal}</div>`
          : `<div class="my-stat-val" style="color:var(--accent);">#${myRankPos}</div><div class="my-stat-lbl">Rank · of ${rankTotal}</div>`)
      : `<div class="my-stat-val" style="color:var(--muted);">—</div><div class="my-stat-lbl">Rank</div>`;
    const todaySent = senderTodayRaw(S.myName, today());
    const pct = S.limitEnabled ? Math.min(100,Math.round(todaySent/S.limitPerDay*100)) : 0;
    const rem = S.limitEnabled ? Math.max(0, S.limitPerDay - todaySent) : null;
    const limitClass = pct>=100?'maxed':pct>=80?'warn':'';
    const limitMsg = S.limitEnabled
      ? (rem===0
          ? `<div class="limit-sub maxed">Daily limit reached · resets tomorrow</div>`
          : `<div class="limit-sub ${rem<=1?'warn':''}">🧩 remaining today: ${rem}</div>`)
      : '';
    myBanner.style.display = '';
    document.getElementById('u-my-banner-wrap').style.display = '';
    myBanner.innerHTML = `<div class="my-banner" style="flex-wrap:wrap;cursor:pointer;" onclick="toggleBannerDrawer()">
      <div style="flex:1;">
        <div class="my-banner-name">👋 ${S.myName} <span class="you-tag">YOU</span></div>
        ${S.limitEnabled?`<div class="limit-mini-bar"><div class="limit-mini-fill ${limitClass}" style="width:${pct}%"></div></div>${limitMsg}`:''}
      </div>
      <div class="my-stat-blk" style="border-right:1px solid var(--border);padding-right:20px;">${rankDisplay}</div>
      <div class="my-stat-blk"><div class="my-stat-val" style="color:var(--accent3)">${me.sent}</div><div class="my-stat-lbl">Sent</div></div>
      <div class="my-stat-blk"><div class="my-stat-val" style="color:var(--accent2)">${me.received}</div><div class="my-stat-lbl">Received</div></div>
      <div class="my-stat-blk"><div class="my-stat-val" style="color:var(--accent)">${me.total}</div><div class="my-stat-lbl">Total</div></div>
      <div style="display:flex;align-items:center;padding-left:8px;">
        <span id="banner-expand-hint" style="font-size:10px;font-weight:700;color:var(--accent);letter-spacing:0.5px;">▼ My History</span>
      </div>
      <div id="banner-drawer" style="display:none;width:100%;flex-basis:100%;margin-top:14px;padding-top:14px;border-top:1px solid rgba(92,107,192,0.25);">
        <div class="drawer-tabs" style="margin-bottom:12px;">
          <button class="drawer-tab active" id="banner-tab-recv" onclick="switchBannerTab(event,'recv')">🔴 Received</button>
          <button class="drawer-tab" id="banner-tab-sent" onclick="switchBannerTab(event,'sent')">🟢 Sent</button>
        </div>
        <div id="banner-drawer-body"></div>
      </div>
    </div>`;
  } else {
    myBanner.style.display = 'none';
    document.getElementById('u-my-banner-wrap').style.display = 'none';
  }

  // Leaderboard
  const lb = document.getElementById('u-leaderboard');
  const maxSent = Math.max(...ranked.map(p=>p.sent),1);
  const maxRecv = Math.max(...ranked.map(p=>p.received),1);

  if (ranked.length===0 || ranked.every(p=>p.total===0)) {
    let emptyHTML;
    if (!_storageReady) {
      // Still loading
      emptyHTML = `<div class="empty-state"><img src="mascot_happy.png" alt="" style="width:64px;height:auto;animation:bounce 1s ease-in-out infinite;margin-bottom:8px;"><div class="empty-title">Loading…</div><div class="empty-sub">Fetching board data</div></div>`;
    } else if (_lastRefreshFailed) {
      // Failed to load — no cache, no data
      emptyHTML = `<div class="empty-state"><img src="mascot_sad.png" alt="" style="width:64px;height:auto;margin-bottom:8px;"><div class="empty-title">Board not loaded</div><div class="empty-sub">PuzzleBoard couldn't reach its data server. This usually resolves on its own — try ↻ again in a moment.</div></div>`;
    } else if (S.members.length === 0) {
      // Connected but genuinely empty — new installation
      emptyHTML = `<div class="empty-state"><img src="mascot_happy.png" alt="" style="width:64px;height:auto;margin-bottom:8px;"><div class="empty-title">No puzzle pieces yet</div><div class="empty-sub">Recognitions will appear here once pieces start flowing.</div></div>`;
    } else {
      // Has members but no entries in this period
      emptyHTML = `<div class="empty-state"><img src="mascot_happy.png" alt="" style="width:64px;height:auto;margin-bottom:8px;"><div class="empty-title">No puzzle pieces yet</div><div class="empty-sub">No recognitions logged for this period yet.</div></div>`;
    }
    lb.innerHTML = emptyHTML;
  } else {
    const searchQuery = (document.getElementById('lb-search')?.value || '').toLowerCase().trim();

    // Update subtitle
    const subLeft  = document.getElementById('lb-subtitle-left');
    const subRight = document.getElementById('lb-subtitle-right');
    if (subLeft)  subLeft.textContent  = searchQuery ? `${ranked.length} total` : 'Top 15';
    if (subRight) subRight.textContent = searchQuery
      ? `Showing all matches`
      : `Search all ${ranked.length} participants to find your ranking`;
    const filtered = searchQuery
      ? ranked.filter(p => p.name.toLowerCase().includes(searchQuery))
      : ranked;

    const SHOW_LIMIT = 15;
    const visible = searchQuery.length > 0 ? filtered : filtered.slice(0, SHOW_LIMIT);
    const hiddenCount = filtered.length - visible.length;

    lb.innerHTML = visible.map((p,i)=>{
      const globalRank = ranked.indexOf(p);
      const isMe = p.name===S.myName;
      const rankLabel = globalRank===0?'🥇':globalRank===1?'🥈':globalRank===2?'🥉':`#${globalRank+1}`;
      const rankClass = globalRank===0?'rank-1':globalRank===1?'rank-2':globalRank===2?'rank-3':'';
      const sortVal   = S.sort==='sent'?p.sent:S.sort==='received'?p.received:p.total;
      const cbClass   = S.sort==='sent'?'cb-sent':S.sort==='received'?'cb-recv':'cb-total';
      const sortLbl   = S.sort==='sent'?'sent':S.sort==='received'?'recv':'total';
      const cardId = 'lb-' + p.name.replace(/[^a-z0-9]/gi,'_');
      return `<div class="lb-card ${rankClass} ${isMe?'is-me':''}" id="${cardId}" style="animation-delay:${i*40}ms">
        <div class="rank-num">${rankLabel}</div>
        <div class="person-info">
          <div class="person-name">${isMe?'<span class="me-dot"></span>':''}${p.name}</div>
          <div class="person-meta">🟢 ${p.sent} sent · 🔴 ${p.received} received</div>
        </div>
        <div class="dual-bars">
          <div class="bar-row"><div class="bar-lbl">SENT</div><div class="bar-track"><div class="bar-fill bf-sent" style="width:${Math.round(p.sent/maxSent*100)}%"></div></div><div class="bar-val">${p.sent}</div></div>
          <div class="bar-row"><div class="bar-lbl">RECV</div><div class="bar-track"><div class="bar-fill bf-recv" style="width:${Math.round(p.received/maxRecv*100)}%"></div></div><div class="bar-val">${p.received}</div></div>
        </div>
        <div class="count-col"><div class="count-big ${cbClass}">${sortVal}</div><div class="count-lbl">${sortLbl}</div></div>
      </div>`;
    }).join('') + (hiddenCount > 0 && !searchQuery
      ? `<div style="text-align:center;padding:12px 0 4px;color:var(--muted);font-size:12px;font-family:'DM Mono',monospace;">
           +${hiddenCount} more · use search to find anyone
         </div>`
      : filtered.length === 0 && searchQuery
        ? `<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px;">No results for "${searchQuery}"</div>`
        : '');
  }

  // Kudos spotlight
  startSpotlight();

  // Today's pulse
  const todayEntries = applyLimit(S.entries.filter(e=>e.date===today()));
  const todayTotal   = todayEntries.reduce((s,e)=>s+e.count,0);
  document.getElementById('u-today-count').textContent = todayTotal;

  const todaySenders = {};
  todayEntries.forEach(e=>todaySenders[e.sender]=(todaySenders[e.sender]||0)+e.count);
  const todayEl = document.getElementById('u-today-breakdown');
  const pairs = Object.entries(todaySenders).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const tdMax = pairs[0]?.[1]||1;
  todayEl.innerHTML = pairs.length===0
    ? `<div style="text-align:center;font-size:11px;color:var(--muted);padding:6px 0">No pieces given today</div>`
    : pairs.map(([name,count])=>{
      const rem = S.limitEnabled ? Math.max(0,S.limitPerDay-count) : null;
      return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <div style="font-size:11px;font-weight:700;width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name.split(' ')[0]}</div>
        <div style="flex:1;height:3px;background:var(--border);border-radius:2px;overflow:hidden;"><div style="width:${Math.round(count/tdMax*100)}%;height:100%;background:var(--accent3);border-radius:2px"></div></div>
        <div style="font-size:11px;font-family:'DM Mono',monospace;color:var(--text)">${count}🧩${rem!==null?` <span style="color:var(--warn)">(${rem} left)</span>`:''}</div>
      </div>`;
    }).join('');

  // Sync period pill labels
  updatePeriodLabel();

  // Milestone notifications
  renderMilestones();

  // Activity feed
  const af = document.getElementById('u-activity');
  const recent = [...S.entries]
    .map((e,i) => ({...e, _idx: i}))
    .sort((a,b) => b.date.localeCompare(a.date) || b._idx - a._idx)
    .slice(0,25);
  af.innerHTML = recent.length===0
    ? `<div style="text-align:center;padding:14px;color:var(--muted);font-size:12px;">No activity yet</div>`
    : recent.map((e,i)=>{
      const pieces = '🧩'.repeat(Math.min(e.count,5))+(e.count>5?`+${e.count-5}`:'');
      const overLimit = buildOverLimitSet().has(e.fp);
      const limitBadge = overLimit ? '<span title="Over daily limit — not counted in totals" style="font-size:10px;color:var(--warn);margin-left:4px;">⚠ limit</span>' : '';
      return `<div class="act-item" style="animation-delay:${i*20}ms${overLimit?';opacity:0.65':''}">
        <div class="act-icon">🧩</div>
        <div class="act-body"><strong>${e.sender}</strong> → <span class="act-recv">${e.recipient}</span> ${pieces}${limitBadge}${e.note?`<br><span style="font-size:10px;font-style:italic">"${e.note}"</span>`:''}</div>
        <div class="act-time">${e.date}</div>
      </div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════
//  RENDER — ADMIN VIEW
// ═══════════════════════════════════════════════════════════
function renderAdmin() {
  document.getElementById('a-channel').textContent = S.channel;
  document.getElementById('a-channel-name').value = S.channel;
  document.getElementById('a-pin-input').value = '';

  // Default view controls
  const defPeriodEl = document.getElementById('a-default-period');
  if (defPeriodEl) {
    // Try to match stored defaultPeriod to a select option; fall back to closest
    const dp = S.defaultPeriod || '7d';
    let matched = false;
    for (const opt of defPeriodEl.options) {
      if (opt.value === dp) { defPeriodEl.value = dp; matched = true; break; }
    }
    // If it's a month/quarter with a specific year, select the appropriate optgroup option
    if (!matched) {
      if (dp.startsWith('month:'))   defPeriodEl.value = 'month:current';
      else if (dp.startsWith('quarter:')) {
        const qPart = dp.split('-').pop(); // 'Q1'..'Q4'
        defPeriodEl.value = `quarter:current-${qPart}`;
      }
    }
    // Show human-readable preview
    const previewEl = document.getElementById('a-default-period-preview');
    if (previewEl) {
      const saved = S.defaultPeriod || '7d';
      const labels = {'7d':'Last 7 Days','30d':'Last 30 Days','all':'All Time'};
      const label  = labels[saved] || (saved.startsWith('month:') ? 'Month: ' + saved.slice(6) : saved.startsWith('quarter:') ? saved.slice(8) : saved);
      previewEl.textContent = saved !== '7d' ? `Currently set to: ${label}` : '';
    }
  }
  // Default sort buttons
  setDefaultSort(S.defaultSort || 'received');
  document.getElementById('a-limit-val').value = S.limitPerDay;

  // Milestone toggle states
  const bdayTog = document.getElementById('a-bday-toggle');
  const annTog  = document.getElementById('a-ann-toggle');
  if (bdayTog) bdayTog.classList.toggle('on', S.birthdayEnabled);
  if (annTog)  annTog.classList.toggle('on',  S.anniversaryEnabled);
  const bdayBonus = document.getElementById('a-bday-bonus');
  const annBonus  = document.getElementById('a-ann-bonus');
  const msBonus   = document.getElementById('a-milestone-bonus');
  if (bdayBonus) bdayBonus.value = S.birthdayBonus;
  if (annBonus)  annBonus.value  = S.anniversaryBonus;
  if (msBonus)   msBonus.value   = S.milestoneBonus;

  // Limit toggle state
  const tog = document.getElementById('a-limit-toggle');
  tog.classList.toggle('on', S.limitEnabled);
  document.getElementById('a-limit-fields').style.opacity     = S.limitEnabled?'1':'0.4';
  document.getElementById('a-limit-fields').style.pointerEvents = S.limitEnabled?'':'none';
  document.getElementById('a-limit-hint').textContent = S.limitEnabled
    ? `Active — max ${S.limitPerDay} piece${S.limitPerDay!==1?'s':''} per person per day`
    : `Currently off — no cap enforced`;

  // Member list — delegated to renderMemberList (handles search)
  renderMemberList();

  // Summary bar (always-visible at top of admin)
  const allPeople = aggregate(S.entries);
  const allCapped = applyLimit(S.entries);
  const totalGiven  = allCapped.reduce((s,e)=>s+e.count,0);
  const topSenderA  = [...allPeople].filter(p=>p.name!=='Patch').sort((a,b)=>b.sent-a.sent)[0];
  const topRecvrA   = [...allPeople].sort((a,b)=>b.received-a.received)[0];
  const sumTotal   = document.getElementById('a-sum-total');
  const sumSender  = document.getElementById('a-sum-sender');
  const sumRecvr   = document.getElementById('a-sum-recvr');
  const sumMembers = document.getElementById('a-sum-members');
  if (sumTotal)   sumTotal.textContent   = totalGiven || '—';
  if (sumSender)  sumSender.textContent  = topSenderA?.name?.split(' ')[0] || '—';
  if (sumRecvr)   sumRecvr.textContent   = topRecvrA?.name?.split(' ')[0] || '—';
  if (sumMembers) sumMembers.textContent = S.members.length || '—';

  // Populate admin log selects
  populateSelects();
  updateStorageStatus();
  renderArchiveList();
}

function populateSelects() {
  const names = S.members.map(m=>m.name);
  ['al-sender','al-recipient'].forEach(id=>{
    const el = document.getElementById(id);
    const cur = el.value;
    el.innerHTML = `<option value="">— Select —</option>` + names.map(n=>`<option value="${n}" ${n===cur?'selected':''}>${n}</option>`).join('');
  });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN TAB SWITCHING
// ═══════════════════════════════════════════════════════════

let _adminTab = 'people';

function switchAdminTab(tab) {
  _adminTab = tab;
  ['people','settings'].forEach(t => {
    document.getElementById(`atab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`atab-${t}-btn`).classList.toggle('active', t === tab);
  });
}

// ═══════════════════════════════════════════════════════════
//  MEMBER LIST SEARCH (admin People tab)
// ═══════════════════════════════════════════════════════════

let _memberSearchQuery = '';

function filterMemberList(query) {
  _memberSearchQuery = query.trim().toLowerCase();
  renderMemberList();
}

function renderMemberList() {
  const mlEl = document.getElementById('a-member-list');
  if (!mlEl) return;

  const people = aggregate(S.entries);
  const memberStats = {};
  people.forEach(p => memberStats[p.name] = p);

  const q = _memberSearchQuery;
  const filtered = q
    ? S.members.filter(m =>
        m.name.toLowerCase().includes(q) ||
        (m.title||'').toLowerCase().includes(q)
      )
    : S.members;

  if (S.members.length === 0) {
    mlEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px;">No participants yet. Add someone or sync from Teams.</div>`;
    return;
  }

  if (filtered.length === 0) {
    mlEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px;">No participants match "${_memberSearchQuery}"</div>`;
    return;
  }

  mlEl.innerHTML = filtered.map(m => {
    const stats    = memberStats[m.name] || { sent:0, received:0 };
    const initials = m.name.split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
    const safeName = m.name.replace(/'/g, "\'");
    const bdStr    = m.birthday  ? `🎂 ${m.birthday}` : '';
    const hireStr  = m.hireDate ? `🏆 Since ${m.hireDate}` : '';
    const metaParts = [m.title, bdStr, hireStr].filter(Boolean);

    // Highlight search match in name
    let displayName = m.name;
    if (q) {
      const idx = m.name.toLowerCase().indexOf(q);
      if (idx !== -1) {
        displayName = m.name.slice(0,idx)
          + `<mark style="background:rgba(255,159,67,0.25);color:var(--text);border-radius:2px;padding:0 1px;">${m.name.slice(idx,idx+q.length)}</mark>`
          + m.name.slice(idx+q.length);
      }
    }

    return `<div class="member-row">
      <div class="member-avatar">${initials}</div>
      <div style="flex:1;min-width:0;">
        <div class="member-name">${displayName}</div>
        ${metaParts.length ? `<div class="text-sm text-muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${metaParts.join(' · ')}</div>` : ''}
      </div>
      <div class="member-stats">🟢 ${stats.sent} sent · 🔴 ${stats.received} recv</div>
      <button class="btn btn-ghost btn-sm" onclick="openRecordsModal('${safeName}')">📋 Records</button>
      <button class="btn btn-ghost btn-sm" onclick="openEditMember('${safeName}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="confirmDeleteMember('${safeName}')">✕</button>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
//  TEAMS SYNC
// ═══════════════════════════════════════════════════════════
function syncFromTeams() {
  openModal('teamsSyncModal');
}

function applyTeamsSyncJSON() {
  const raw = document.getElementById('teams-sync-paste').value.trim();
  if (!raw) { showToast('Paste the JSON from Claude first.', true); return; }
  let names = [];
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    names = Array.isArray(parsed) ? parsed : (parsed.names || []);
  } catch(e) {
    showToast('Could not parse JSON — copy exactly what Claude returned.', true);
    return;
  }
  if (!names.length) { showToast('No names found in the pasted JSON.', true); return; }

  const incomingNormalized = names.map(n => String(n).trim());

  // Add net-new members
  let added = 0;
  incomingNormalized.forEach(name => {
    if (name && !S.members.find(m => m.name === name)) {
      S.members.push({ name, title: '', addedAt: today() });
      added++;
    }
  });

  // Find existing members not present in the incoming list
  const missing = S.members
    .map(m => m.name)
    .filter(name => !incomingNormalized.includes(name));

  save(); renderAdmin(); closeModal('teamsSyncModal');
  document.getElementById('teams-sync-paste').value = '';

  // Build the result message
  const addedMsg  = added ? `${added} new participant${added !== 1 ? 's' : ''} added.` : 'No new participants to add.';
  const missingMsg = missing.length
    ? ` ⚠ ${missing.length} member${missing.length !== 1 ? 's' : ''} not in the distribution list: ${missing.join(', ')}. Review and remove manually if needed.`
    : '';

  showToast(addedMsg + missingMsg, missing.length > 0);

  // If there are missing members, also show a more readable admin alert
  if (missing.length) {
    setTimeout(() => {
      const listStr = missing.map(n => `• ${n}`).join('\n');
      alert(`⚠ Sync complete — the following ${missing.length} participant${missing.length !== 1 ? 's are' : ' is'} not in the distribution list:\n\n${listStr}\n\nNo changes were made. Remove them manually from the Participants panel if they've left the team.`);
    }, 300);
  }
}

// ═══════════════════════════════════════════════════════════
//  FILE IMPORT (CSV / XLSX)
// ═══════════════════════════════════════════════════════════

let _fiRows    = [];   // raw rows from file [{col: val, ...}]
let _fiHeaders = [];   // detected column headers
let _fiMapped  = {};   // { name: colIdx, title: colIdx, birthday: colIdx, hireDate: colIdx }

function openFileImportModal() {
  fiReset();
  openModal('fileImportModal');
}

function fiReset() {
  _fiRows = []; _fiHeaders = []; _fiMapped = {};
  document.getElementById('fi-step2').style.display = 'none';
  document.getElementById('fi-step3').style.display = 'none';
  document.getElementById('fi-import-btn').style.display = 'none';
  document.getElementById('fi-file-name').style.display = 'none';
  document.getElementById('fi-file-input').value = '';
  document.getElementById('fi-dropzone').style.display = '';
}

function fiDragOver(e) {
  e.preventDefault();
  document.getElementById('fi-dropzone').classList.add('drag-over');
}
function fiDragLeave(e) {
  document.getElementById('fi-dropzone').classList.remove('drag-over');
}
function fiDrop(e) {
  e.preventDefault();
  document.getElementById('fi-dropzone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processImportFile(file);
}
function fiFileSelected(e) {
  const file = e.target.files[0];
  if (file) processImportFile(file);
}

function processImportFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv','xlsx','xls'].includes(ext)) {
    showToast('Unsupported file type. Use .csv, .xlsx, or .xls', true);
    return;
  }

  const nameEl = document.getElementById('fi-file-name');
  nameEl.textContent = `📄 ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
  nameEl.style.display = '';
  document.getElementById('fi-dropzone').style.display = 'none';

  const reader = new FileReader();

  if (ext === 'csv') {
    reader.onload = ev => {
      const text = ev.target.result;
      parseCSVToRows(text);
      fiShowMapper();
    };
    reader.readAsText(file);
  } else {
    reader.onload = ev => {
      const data = new Uint8Array(ev.target.result);
      try {
        const wb   = XLSX.read(data, { type: 'array', cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        parseSheetRowsToRows(json);
        fiShowMapper();
      } catch(err) {
        showToast('Could not read Excel file. Try saving as CSV first.', true);
        fiReset();
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function parseCSVToRows(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return;

  // Simple CSV parser — handles quoted fields
  function parseLine(line) {
    const fields = [];
    let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    fields.push(cur.trim());
    return fields;
  }

  _fiHeaders = parseLine(lines[0]);
  _fiRows = lines.slice(1).map(l => {
    const vals = parseLine(l);
    const obj = {};
    _fiHeaders.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  }).filter(r => Object.values(r).some(v => v.trim()));
}

function parseSheetRowsToRows(json) {
  if (!json.length) return;
  _fiHeaders = json[0].map(h => String(h).trim());
  _fiRows = json.slice(1).map(row => {
    const obj = {};
    _fiHeaders.forEach((h, i) => obj[h] = row[i] !== undefined ? String(row[i]).trim() : '');
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

// Smart column auto-detection
function fiAutoDetect() {
  const lower = h => h.toLowerCase();
  const find  = (...terms) => _fiHeaders.findIndex(h => terms.some(t => lower(h).includes(t)));

  _fiMapped = {
    name:     find('name', 'full name', 'employee', 'person'),
    title:    find('title', 'role', 'position', 'job'),
    birthday: find('birthday', 'birth', 'dob', 'date of birth'),
    hireDate: find('hire', 'start', 'joined', 'anniversary', 'employment date')
  };
}

function fiShowMapper() {
  if (!_fiRows.length) { showToast('No data rows found in file.', true); fiReset(); return; }
  fiAutoDetect();

  const fields = [
    { key: 'name',     label: 'Full Name *',   required: true },
    { key: 'title',    label: 'Title / Role',   required: false },
    { key: 'birthday', label: '🎂 Birthday',    required: false },
    { key: 'hireDate', label: '🏆 Hire Date',   required: false },
  ];

  const noneOpt = '<option value="-1">— Skip —</option>';
  const headerOpts = _fiHeaders.map((h, i) => `<option value="${i}">${h}</option>`).join('');

  document.getElementById('fi-column-mapper').innerHTML = fields.map(f => `
    <div class="column-mapper">
      <div style="font-size:12px;font-weight:700;color:${f.required?'var(--text)':'var(--muted)'};">${f.label}</div>
      <div class="mapper-arrow">←</div>
      <select class="form-select" style="font-size:12px;" onchange="fiMapChange('${f.key}',this.value)">
        ${f.required ? '' : noneOpt}
        ${_fiHeaders.map((h, i) =>
          `<option value="${i}" ${_fiMapped[f.key] === i ? 'selected' : ''}>${h}</option>`
        ).join('')}
        ${f.required ? noneOpt : ''}
      </select>
    </div>
  `).join('');

  document.getElementById('fi-step2').style.display = '';
  fiUpdatePreview();
}

function fiMapChange(field, val) {
  _fiMapped[field] = parseInt(val);
  fiUpdatePreview();
}

// Normalise birthday input → MM-DD
function normBirthday(raw) {
  if (!raw) return null;
  // Handle JavaScript Date objects from XLSX library
  if (raw instanceof Date || (typeof raw === 'object' && raw !== null && typeof raw.getMonth === 'function')) {
    try { return `${String(raw.getMonth()+1).padStart(2,'0')}-${String(raw.getDate()).padStart(2,'0')}`; } catch(e) {}
  }
  const s = String(raw).trim();
  if (!s) return null;
  // ISO string with time e.g. '1985-06-15T00:00:00.000Z'
  const iso = s.match(/^\d{4}-(\d{2})-(\d{2})T/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  // JS Date.toString() e.g. 'Mon Oct 26 2020 00:00:00 GMT-0500 (Central Daylight Time)'
  if (/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // Excel date serial → JS date (SheetJS cellDates handles this but fallback)
  const num = Number(s);
  if (!isNaN(num) && num > 1000) {
    // Looks like an Excel date serial
    const d = new Date(Math.round((num - 25569) * 86400 * 1000));
    return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // Try common formats: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, M/D, DD-Mon
  const patterns = [
    /^(\d{1,2})[\/-](\d{1,2})(?:[\/-]\d{2,4})?$/,   // MM/DD or MM/DD/YYYY
    /^\d{4}[\/-](\d{1,2})[\/-](\d{1,2})$/             // YYYY-MM-DD
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return `${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // Month name: "Jun 15", "15-Jun"
  const monthNames = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const mn = s.match(/([a-zA-Z]{3})\s*(\d{1,2})|^(\d{1,2})\s*[\-\/]\s*([a-zA-Z]{3})/i);
  if (mn) {
    const mon = monthNames[(mn[1]||mn[4]).toLowerCase()];
    const day = parseInt(mn[2]||mn[3]);
    if (mon && day) return `${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return null;
}

// Normalise hire date → YYYY-MM-DD
function normHireDate(raw) {
  if (!raw) return null;
  // Handle JS Date objects (XLSX cellDates:true) or date-like objects
  if (raw instanceof Date || (typeof raw === 'object' && raw !== null && typeof raw.getFullYear === 'function')) {
    try { return raw.toISOString().split('T')[0]; } catch(e) {}
  }
  const s = String(raw).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  // ISO string with time e.g. '2019-03-15T00:00:00.000Z'
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  // JS Date.toString() format e.g. 'Mon Oct 26 2020 00:00:00 GMT-0500 (Central Daylight Time)'
  const jsd = new Date(s);
  if (!isNaN(jsd.getTime())) return jsd.toISOString().split('T')[0];
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Excel date serial number
  const num = Number(s);
  if (!isNaN(num) && num > 1000) {
    const d = new Date(Math.round((num - 25569) * 86400 * 1000));
    return d.toISOString().split('T')[0];
  }
  // MM/DD/YYYY or M/D/YYYY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  // M/D/YY
  const sh = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (sh) {
    const yr = parseInt(sh[3]) > 50 ? '19'+sh[3] : '20'+sh[3];
    return `${yr}-${sh[1].padStart(2,'0')}-${sh[2].padStart(2,'0')}`;
  }
  // DD-Mon-YYYY e.g. '15-Mar-2019'
  const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const dm = s.match(/^(\d{1,2})[\-\/\s]([A-Za-z]{3})[\-\/\s](\d{4})$/);
  if (dm) {
    const mo = mon.indexOf(dm[2].toLowerCase()) + 1;
    if (mo) return `${dm[3]}-${String(mo).padStart(2,'0')}-${dm[1].padStart(2,'0')}`;
  }
  // Mon DD, YYYY e.g. 'Mar 15, 2019'
  const ml = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (ml) {
    const mo = mon.indexOf(ml[1].toLowerCase()) + 1;
    if (mo) return `${ml[3]}-${String(mo).padStart(2,'0')}-${ml[2].padStart(2,'0')}`;
  }
  return null;
}

function fiGetVal(row, colIdx) {
  if (colIdx === -1 || colIdx === undefined) return '';
  return row[_fiHeaders[colIdx]] || '';
}

function fiUpdatePreview() {
  const tbody = document.getElementById('fi-preview-body');
  const countEl = document.getElementById('fi-preview-count');
  const importBtn = document.getElementById('fi-import-btn');

  if (_fiMapped.name === -1 || _fiMapped.name === undefined) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:12px;color:var(--muted);">Map the Full Name column to continue</td></tr>`;
    importBtn.style.display = 'none';
    document.getElementById('fi-step3').style.display = 'none';
    return;
  }

  const preview = _fiRows.slice(0, 50).map(row => {
    const name     = fiGetVal(row, _fiMapped.name).trim();
    const title    = fiGetVal(row, _fiMapped.title).trim();
    const bdRaw    = fiGetVal(row, _fiMapped.birthday);
    const hrRaw    = fiGetVal(row, _fiMapped.hireDate);
    const birthday = normBirthday(bdRaw);
    const hireDate = normHireDate(hrRaw);
    const exists   = !!S.members.find(m => m.name.toLowerCase() === name.toLowerCase());
    const skip     = !name;
    return { name, title, birthday, hireDate, exists, skip };
  });

  const valid   = preview.filter(r => !r.skip && !r.exists);
  const invalid = preview.filter(r => r.skip);

  // Detect existing members that have missing fields we could fill in
  const updatable = preview.filter(r => !r.skip && r.exists).filter(r => {
    const existing = S.members.find(m => m.name.toLowerCase() === r.name.toLowerCase());
    if (!existing) return false;
    return (!existing.title && r.title) ||
           (!existing.birthday && r.birthday) ||
           (!existing.hireDate && r.hireDate);
  });
  const dupes = preview.filter(r => !r.skip && r.exists && !updatable.find(u => u.name === r.name));

  const totalValid = _fiRows.filter(r => {
    const name = fiGetVal(r, _fiMapped.name).trim();
    return name && !S.members.find(m => m.name.toLowerCase() === name.toLowerCase());
  }).length;
  const totalUpdatable = _fiRows.filter(r => {
    const name = fiGetVal(r, _fiMapped.name).trim();
    if (!name) return false;
    const existing = S.members.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (!existing) return false;
    const title    = fiGetVal(r, _fiMapped.title).trim();
    const birthday = normBirthday(fiGetVal(r, _fiMapped.birthday));
    const hireDate = normHireDate(fiGetVal(r, _fiMapped.hireDate));
    return (!existing.title && title) || (!existing.birthday && birthday) || (!existing.hireDate && hireDate);
  }).length;

  const parts = [];
  if (totalValid)    parts.push(`${totalValid} new`);
  if (totalUpdatable) parts.push(`${totalUpdatable} will update`);
  if (dupes.length)  parts.push(`${dupes.length} no changes`);
  if (invalid.length) parts.push(`${invalid.length} skipped (no name)`);
  countEl.textContent = '— ' + (parts.join(' · ') || 'nothing to import');

  tbody.innerHTML = preview.map(r => {
    const isUpdatable = updatable.find(u => u.name === r.name);
    const statusColor = r.skip ? 'var(--muted)' : isUpdatable ? 'var(--accent)' : r.exists ? 'var(--muted)' : 'var(--accent3)';
    const statusLabel = r.skip ? 'Skip (no name)' : isUpdatable ? 'Will update' : r.exists ? 'No changes' : 'Will import';
    return `<tr style="${r.skip ? 'opacity:0.4' : ''}">
      <td style="font-weight:${r.exists?'400':'700'}">${r.name || '—'}</td>
      <td style="color:var(--muted)">${r.title || '—'}</td>
      <td style="color:var(--muted);font-family:'DM Mono',monospace">${r.birthday || '—'}</td>
      <td style="color:var(--muted);font-family:'DM Mono',monospace">${r.hireDate || '—'}</td>
      <td style="color:${statusColor};font-weight:700;white-space:nowrap">${statusLabel}</td>
    </tr>`;
  }).join('');

  document.getElementById('fi-step3').style.display = '';
  importBtn.style.display = (totalValid > 0 || totalUpdatable > 0) ? '' : 'none';
}

function fiRunImport() {
  if (_fiMapped.name === -1 || _fiMapped.name === undefined) return;

  let added = 0; let updated = 0; let skipped = 0;
  _fiRows.forEach(row => {
    const name     = fiGetVal(row, _fiMapped.name).trim();
    if (!name) { skipped++; return; }
    const title    = fiGetVal(row, _fiMapped.title).trim();
    const birthday = normBirthday(fiGetVal(row, _fiMapped.birthday)) || null;
    const hireDate = normHireDate(fiGetVal(row, _fiMapped.hireDate)) || null;

    const existing = S.members.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      console.log('[PuzzleBoard] merge check:', name, { title, birthday, hireDate, existingBirthday: existing.birthday, existingHireDate: existing.hireDate });
      // Merge — only overwrite fields that are blank on the existing record
      // and non-blank in the import row
      let changed = false;
      if (!existing.title    && title)    { existing.title    = title;    changed = true; }
      if (!existing.birthday && birthday) { existing.birthday = birthday; changed = true; }
      if (!existing.hireDate && hireDate) { existing.hireDate = hireDate; changed = true; }
      if (changed) updated++;
      else skipped++;
      return;
    }

    S.members.push({ name, title, birthday, hireDate, addedAt: today() });
    added++;
  });

  save(); renderAdmin(); closeModal('fileImportModal');
  const parts = [];
  if (added)   parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (skipped) parts.push(`${skipped} skipped`);
  showToast('✓ ' + parts.join(' · '));
}

// ═══════════════════════════════════════════════════════════
//  MEMBER MANAGEMENT
// ═══════════════════════════════════════════════════════════
function openAddMember() {
  document.getElementById('new-member-name').value = '';
  document.getElementById('new-member-title').value = '';
  openModal('addMemberModal');
}

function submitAddMember() {
  const name     = document.getElementById('new-member-name').value.trim();
  const title    = document.getElementById('new-member-title').value.trim();
  const birthday = document.getElementById('new-member-bday').value.trim();
  const hireDate = document.getElementById('new-member-hire').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  if (S.members.find(m=>m.name.toLowerCase()===name.toLowerCase())) { alert('That person is already in the list.'); return; }
  // Validate birthday format MM-DD
  if (birthday && !/^(0?[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday)) {
    alert('Birthday format should be MM-DD, e.g. 06-15'); return;
  }
  S.members.push({ name, title, birthday: birthday||null, hireDate: hireDate||null, addedAt: today() });
  save(); renderAdmin(); closeModal('addMemberModal');
  // Clear fields
  ['new-member-name','new-member-title','new-member-bday','new-member-hire'].forEach(id => document.getElementById(id).value = '');
  showToast(`✓ Added ${name}`);
}

function openEditMember(name) {
  const m = S.members.find(m => m.name === name);
  if (!m) return;
  document.getElementById('edit-member-orig').value  = name;
  document.getElementById('edit-member-name').value  = m.name;
  document.getElementById('edit-member-title').value = m.title || '';
  document.getElementById('edit-member-bday').value  = m.birthday || '';
  document.getElementById('edit-member-hire').value  = m.hireDate || '';
  openModal('editMemberModal');
}

function submitEditMember() {
  const orig     = document.getElementById('edit-member-orig').value;
  const name     = document.getElementById('edit-member-name').value.trim();
  const title    = document.getElementById('edit-member-title').value.trim();
  const birthday = document.getElementById('edit-member-bday').value.trim();
  const hireDate = document.getElementById('edit-member-hire').value.trim();
  if (!name) { alert('Name cannot be empty.'); return; }
  if (birthday && !/^(0?[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday)) {
    alert('Birthday format should be MM-DD, e.g. 06-15'); return;
  }
  const idx = S.members.findIndex(m => m.name === orig);
  if (idx === -1) return;
  S.members[idx] = { ...S.members[idx], name, title, birthday: birthday||null, hireDate: hireDate||null };
  // Update entries if name changed
  if (name !== orig) {
    S.entries = S.entries.map(e => ({
      ...e,
      sender:    e.sender    === orig ? name : e.sender,
      recipient: e.recipient === orig ? name : e.recipient
    }));
    if (S.myName === orig) S.myName = name;
  }
  save(); renderAdmin(); closeModal('editMemberModal');
  showToast(`✓ Updated ${name}`);
}

function confirmDeleteMember(name) {
  const entryCount = S.entries.filter(e=>e.sender===name||e.recipient===name).length;
  showConfirm(
    '⚠️',
    `Remove "${name}"?`,
    `This will permanently delete this person and their ${entryCount} associated record${entryCount!==1?'s':''}. This cannot be undone.`,
    ()=>deleteMember(name)
  );
}

function deleteMember(name) {
  S.members  = S.members.filter(m=>m.name!==name);
  S.entries  = S.entries.filter(e=>e.sender!==name&&e.recipient!==name);
  if (S.myName===name) S.myName='';
  save(); renderAdmin();
  showToast(`✓ Removed ${name} and their records`);
}

// ═══════════════════════════════════════════════════════════
//  IDENTITY (user)
// ═══════════════════════════════════════════════════════════
let _identityNames = [];
let _identityRequired = true; // true on load, false if user manually reopens

function openIdentityModal(required = true) {
  _identityRequired = required;
  _identityNames = S.members.length
    ? S.members.map(m => m.name)
    : [...new Set(S.entries.flatMap(e => [e.sender, e.recipient]))].sort();

  document.getElementById('identity-search').value = '';
  // Always show skip button
  document.getElementById('identity-skip-btn').style.display = '';

  renderIdentityList('');
  openModal('identityModal');
  setTimeout(() => document.getElementById('identity-search').focus(), 180);
}

// Backdrop click — only dismissible if not required
function maybeCloseIdentity(e) {
  if (e.target !== document.getElementById('identityModal')) return;
  if (!_identityRequired) closeModal('identityModal');
}

function skipIdentity() {
  closeModal('identityModal');
}

function filterIdentityList(query) {
  renderIdentityList(query);
}

function renderIdentityList(query) {
  const list    = document.getElementById('identity-list');
  const noMatch = document.getElementById('identity-no-results');
  const q       = query.trim().toLowerCase();

  if (_identityNames.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px;">No participants yet. Ask your admin to add people first.</div>`;
    noMatch.style.display = 'none';
    return;
  }

  // Global substring match — works on any part of the name (first, last, middle)
  const filtered = q
    ? _identityNames.filter(name => name.toLowerCase().includes(q))
    : _identityNames;

  if (filtered.length === 0) {
    list.innerHTML = '';
    noMatch.style.display = '';
    return;
  }

  noMatch.style.display = 'none';
  list.innerHTML = filtered.map(name => {
    const initials   = name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    const m          = S.members.find(m => m.name === name);
    const isSelected = S.myName === name;

    // Highlight matched substring in the displayed name
    let displayName = name;
    if (q) {
      const idx = name.toLowerCase().indexOf(q);
      if (idx !== -1) {
        displayName =
          name.slice(0, idx) +
          `<mark style="background:rgba(124,108,255,0.3);color:var(--text);border-radius:2px;padding:0 1px;">${name.slice(idx, idx + q.length)}</mark>` +
          name.slice(idx + q.length);
      }
    }

    // Escape name for onclick attribute (handle apostrophes etc.)
    const safeName = name.replace(/'/g, "\\'");
    return `<div class="identity-option ${isSelected ? 'selected' : ''}" onclick="selectIdentity('${safeName}')">
      <div class="id-avatar">${initials}</div>
      <div style="flex:1;">
        <div class="id-name">${displayName}</div>
        ${m?.title ? `<div class="id-meta">${m.title}</div>` : ''}
      </div>
      ${isSelected ? '<div style="margin-left:auto;color:var(--accent);font-size:18px">✓</div>' : ''}
    </div>`;
  }).join('');
}

function selectIdentity(name) {
  S.myName = name;
  // Do not call save() — identity is session-only, never persisted
  renderUser(); closeModal('identityModal');
  showToast(`👋 Welcome, ${name.split(' ')[0]}!`);
}

// ═══════════════════════════════════════════════════════════
//  LOG PUZZLE — ADMIN
// ═══════════════════════════════════════════════════════════
function openAdminLogModal() {
  document.getElementById('al-date').value = today();
  document.getElementById('al-count').value = '1';
  document.getElementById('al-note').value = '';
  ['sender','recipient'].forEach(f => {
    document.getElementById(`al-${f}`).value = '';
    document.getElementById(`al-${f}-search`).value = '';
    document.getElementById(`al-${f}-dropdown`).style.display = 'none';
  });
  openModal('adminLogModal');
  setTimeout(() => document.getElementById('al-sender-search').focus(), 180);
}

function submitAdminLog() {
  const sender    = document.getElementById('al-sender').value;
  const recipient = document.getElementById('al-recipient').value;
  const count     = parseInt(document.getElementById('al-count').value)||1;
  const date      = document.getElementById('al-date').value||today();
  const note      = document.getElementById('al-note').value.trim();
  if (!sender)    { alert('Select a sender.'); return; }
  if (!recipient) { alert('Select a recipient.'); return; }
  if (sender===recipient) { alert("Sender and recipient can't be the same."); return; }
  const fp = makeFp(sender, recipient, date, note);
  S.entries.push({ sender, recipient, count, date, note, fp });
  save(); renderAdmin();
  closeModal('adminLogModal');
  showToast('Entry logged');
}

// ═══════════════════════════════════════════════════════════
//  PATCH BONUS
// ═══════════════════════════════════════════════════════════
function openPatchBonusModal() {
  document.getElementById('pb-date').value = today();
  document.getElementById('pb-count').value = '1';
  document.getElementById('pb-reason').value = '';
  document.getElementById('pb-recipient').value = '';
  document.getElementById('pb-recipient-search').value = '';
  document.getElementById('pb-recipient-dropdown').style.display = 'none';
  openModal('patchBonusModal');
  setTimeout(() => document.getElementById('pb-recipient-search').focus(), 180);
}

function filterPbRecipient(query) {
  const dd      = document.getElementById('pb-recipient-dropdown');
  const hidden  = document.getElementById('pb-recipient');
  hidden.value  = ''; // clear selection when typing
  const q = query.trim().toLowerCase();
  if (!q) { dd.style.display = 'none'; return; }
  const matches = S.members
    .filter(m => m.name.toLowerCase().includes(q))
    .sort((a,b) => a.name.localeCompare(b.name))
    .slice(0, 10);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(m =>
    `<div onclick="selectPbRecipient('${m.name.replace(/'/g, "\'")}')"
      style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text);"
      onmouseover="this.style.background='var(--surface2)'"
      onmouseout="this.style.background=''">${m.name}</div>`
  ).join('');
  dd.style.display = 'block';
}

function selectPbRecipient(name) {
  document.getElementById('pb-recipient').value = name;
  document.getElementById('pb-recipient-search').value = name;
  document.getElementById('pb-recipient-dropdown').style.display = 'none';
}

function filterAlField(field, query) {
  const dd     = document.getElementById(`al-${field}-dropdown`);
  const hidden = document.getElementById(`al-${field}`);
  hidden.value = '';
  const q = query.trim().toLowerCase();
  if (!q) { dd.style.display = 'none'; return; }
  const matches = S.members
    .filter(m => m.name.toLowerCase().includes(q))
    .sort((a,b) => a.name.localeCompare(b.name))
    .slice(0, 10);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(m =>
    `<div onclick="selectAlField('${field}','${m.name.replace(/'/g, "\'")}')"
      style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text);"
      onmouseover="this.style.background='var(--surface2)'"
      onmouseout="this.style.background=''">${m.name}</div>`
  ).join('');
  dd.style.display = 'block';
}

function selectAlField(field, name) {
  document.getElementById(`al-${field}`).value = name;
  document.getElementById(`al-${field}-search`).value = name;
  document.getElementById(`al-${field}-dropdown`).style.display = 'none';
}

function submitPatchBonus() {
  const recipient = document.getElementById('pb-recipient').value;
  const count     = parseInt(document.getElementById('pb-count').value) || 1;
  const date      = document.getElementById('pb-date').value || today();
  const reason    = document.getElementById('pb-reason').value.trim();
  if (!recipient) { alert('Select a recipient.'); return; }
  if (!reason)    { alert('Please provide a reason for the bonus.'); return; }
  const fp = makeFp('Patch', recipient, date, reason);
  if (S.entries.some(e => e.fp === fp)) { showToast('This bonus already exists.', true); return; }
  S.entries.push({ sender: 'Patch', recipient, count, date, note: reason, fp, isBonus: true });
  save(); renderAdmin(); renderUser();
  closeModal('patchBonusModal');
  showToast(`⭐ Patch awarded ${count} piece${count!==1?'s':''} to ${recipient}!`);
}

// ═══════════════════════════════════════════════════════════
//  ADMIN SETTINGS
// ═══════════════════════════════════════════════════════════
function adminToggleLimit() {
  S.limitEnabled = !S.limitEnabled;
  save(); renderAdmin();
}

function adminSaveLimit() {
  const val = parseInt(document.getElementById('a-limit-val').value);
  if (!isNaN(val)&&val>=1) { S.limitPerDay=val; save(); renderAdmin(); }
}

async function adminSaveSettings() {
  const channel = document.getElementById('a-channel-name').value.trim();
  const pin     = document.getElementById('a-pin-input').value.trim();
  if (channel) S.channel = channel;
  if (pin && /^\d{6}$/.test(pin)) S.pin = await hashPin(pin);
  else if (pin && !/^\d{6}$/.test(pin)) { alert('PIN must be exactly 6 digits.'); return; }

  // Default period — store the raw sentinel (e.g. 'quarter:current') as-is
  // Resolution to a concrete value happens at runtime in the init block
  const rawPeriod = document.getElementById('a-default-period')?.value || '7d';
  S.defaultPeriod = rawPeriod;

  save(); renderAdmin();
  showToast('Settings saved');
}

// Resolve "current" period tokens to concrete values at runtime (never at save time)
function resolveDefaultPeriod(raw) {
  if (!raw.includes('current')) return raw;
  const now = new Date();
  const y   = now.getFullYear();
  if (raw === 'month:current') {
    return `month:${y}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
  if (raw.startsWith('quarter:current')) {
    const q = Math.ceil((now.getMonth()+1) / 3);
    return `quarter:${y}-Q${q}`;
  }
  // Fixed quarter like "quarter:current-Q2" — use current year + that quarter
  if (raw.startsWith('quarter:current-')) {
    const qStr = raw.split('-').pop(); // 'Q1'..'Q4'
    return `quarter:${y}-${qStr}`;
  }
  return raw;
}

function setDefaultSort(val) {
  S.defaultSort = val;
  // Update button active states
  ['received','sent','total'].forEach(s => {
    const btn = document.getElementById(`ds-${s}`);
    if (!btn) return;
    btn.classList.toggle('btn-admin', s === val);
    btn.classList.toggle('btn-ghost', s !== val);
  });
}

// ═══════════════════════════════════════════════════════════
//  DATA MANAGEMENT
// ═══════════════════════════════════════════════════════════
function previewPasteCount(text) {
  const el = document.getElementById('a-paste-preview');
  if (!el) return;
  if (!text.trim()) { el.textContent = ''; return; }
  const normalised = normalisePuzzles(text);
  const count = (normalised.match(PUZZLE_RE) || []).length;
  if (count === 0) {
    el.innerHTML = `<span style="color:var(--warn);">⚠ No 🧩 detected yet — Teams may have stripped the emoji. Try :puzzle_piece: or [puzzle piece] as a workaround.</span>`;
  } else {
    const parsed = parsePasted(text);
    const { added } = dedupEntries(parsed);
    el.innerHTML = `<span style="color:var(--accent3);">✓ ${count} puzzle piece${count!==1?'s':''} found across ${parsed.length} message${parsed.length!==1?'s':''}</span>`
      + (added.length < parsed.length ? ` <span style="color:var(--muted);">· ${parsed.length - added.length} already counted</span>` : '');
  }
}

function adminPasteImport() {
  const text = document.getElementById('a-paste-import').value.trim();
  if (!text) { alert('Paste some message text first.'); return; }
  const parsed = parsePasted(text);
  if (!parsed.length) { alert('No 🧩 found in pasted text.'); return; }
  const { added, skipped } = dedupEntries(parsed);
  added.forEach(p => {
    [p.sender, p.recipient].forEach(name => {
      const SKIP_NAMES = new Set(['Team','Unknown','PuzzleBoard','Recognition','Patch']);
      if (name && !SKIP_NAMES.has(name) && !S.members.find(m => m.name === name)) {
        S.members.push({ name, title: '', addedAt: today() });
      }
    });
  });
  S.entries.push(...added);
  document.getElementById('a-paste-import').value = '';
  save(); renderAdmin();
  const msg = added.length
    ? `+ ${added.length} entr${added.length !== 1 ? 'ies' : 'y'} added${skipped ? ` - ${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped` : ''}`
    : `All ${skipped} entr${skipped !== 1 ? 'ies' : 'y'} already counted - nothing new added`;
  showToast(msg, added.length === 0);
}

// ── Power Automate Excel Import ─────────────────────────────
// Reads the PuzzleBoard_Data.xlsx format: Creation, Message ID, From, Message
function handleXlsxFileSelect(input) {
  const f = input.files[0];
  if (!f) return;
  const label = document.getElementById('xlsx-import-filename');
  if (label) label.textContent = f.name;
  input.value = '';
  adminXlsxImport(f);
}

function adminXlsxImport(file) {
  console.log('[PuzzleBoard] adminXlsxImport called, file:', file ? file.name : 'null');
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = function(e) { console.error('[PuzzleBoard] FileReader error:', e); showToast('Error reading file.', true); };
  reader.onload = function(e) {
    console.log('[PuzzleBoard] FileReader loaded, bytes:', e.target.result.byteLength);
    try {
      const wb   = XLSX.read(e.target.result, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!rows.length) { showToast('No rows found in spreadsheet.', true); return; }

      // Validate expected columns exist
      const first = rows[0];
      if (!('From' in first) || !('Message' in first)) {
        showToast('Spreadsheet must have "From" and "Message" columns.', true);
        return;
      }

      const SKIP_NAMES = new Set(['Team','Unknown','PuzzleBoard','Recognition','Patch']);
      const PUZZLE_RE  = /🧩/gu;
      const allParsed  = [];
      let skippedByMsgId = 0;

      // Ensure importedMessageIds exists on state
      if (!Array.isArray(S.importedMessageIds)) S.importedMessageIds = [];

      rows.forEach(row => {
        const msgId   = (row['Message ID'] || '').toString().trim();
        const sender  = (row['From'] || '').trim();
        const msgHTML = (row['Message'] || '').toString();
        const dateRaw = row['Creation'] || '';
        const dateStr = dateRaw ? dateRaw.toString().slice(0, 10) : today();

        // Skip if already imported by Message ID
        if (msgId && S.importedMessageIds.includes(msgId)) {
          skippedByMsgId++;
          return;
        }

        // Normalise message HTML — handles <emoji>, <img>, @mention spans
        const msgText = normalisePuzzles(msgHTML);
        console.log('[PuzzleBoard] xlsx row:', { msgId, sender, dateStr, msgText: msgText.trim() });

        // Count puzzle pieces
        const count = (msgText.match(PUZZLE_RE) || []).length;
        console.log('[PuzzleBoard] emoji count:', count);
        if (count === 0) {
          // Record ID so we don't recheck this message next time
          if (msgId) S.importedMessageIds.push(msgId);
          return;
        }

        // Extract recipient from @mention
        const NOT_SURNAME = new Set(['Thank','Thanks','You','Your','Please','For','The',
          'And','But','With','Great','Good','Amazing','Awesome','Nice','Well','Done',
          'Job','Work','Happy','Hope','Just','This','That','Here','Today','From','About']);
        const _mRaw   = msgText.match(/@([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-'.]*(?:\s+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-'.]*)?)/u);
        const _mWords = _mRaw ? _mRaw[1].trim().split(/\s+/) : null;
        let recipient = _mRaw
          ? (_mWords.length === 2 && NOT_SURNAME.has(_mWords[1]) ? _mWords[0] : _mRaw[1].trim())
          : 'Team';
        if (SKIP_NAMES.has(recipient)) recipient = 'Team';
        if (sender && recipient.toLowerCase() === sender.toLowerCase()) recipient = 'Team';

        // Drop unattributed entries — no recipient means likely a mistake
        if (recipient === 'Team') {
          if (msgId) S.importedMessageIds.push(msgId);
          return;
        }

        const note = msgText.replace(PUZZLE_RE, '').replace(/@[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-'.]*(?:\s+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-'.]*)?/gu, '').trim().slice(0, 80);
        const fp   = makeFp(sender || 'Unknown', recipient, dateStr, note);
        allParsed.push({ sender: sender || 'Unknown', recipient, count, date: dateStr, note, fp, msgId });
      });

      if (!allParsed.length) {
        const msg = skippedByMsgId > 0
          ? 'All ' + skippedByMsgId + ' message' + (skippedByMsgId !== 1 ? 's' : '') + ' already imported — nothing new'
          : 'No 🧩 found in spreadsheet.';
        showToast(msg, true);
        return;
      }

      const { added, skipped } = dedupEntries(allParsed);
      added.forEach(p => {
        [p.sender, p.recipient].forEach(name => {
          if (name && !SKIP_NAMES.has(name) && !S.members.find(m => m.name === name)) {
            S.members.push({ name, title: '', addedAt: today() });
          }
        });
      });
      S.entries.push(...added);
      // Record all message IDs (added + fp-skipped) so future imports skip them
      allParsed.forEach(p => { if (p.msgId && !S.importedMessageIds.includes(p.msgId)) S.importedMessageIds.push(p.msgId); });
      save(); renderAdmin();
      const totalSkipped = skippedByMsgId + skipped;
      const skipMsg = totalSkipped ? ' · ' + totalSkipped + ' already imported' : '';
      const msg = added.length
        ? '+ ' + added.length + ' entr' + (added.length !== 1 ? 'ies' : 'y') + ' added from spreadsheet' + skipMsg
        : 'All messages already imported — nothing new added';
      showToast(msg, added.length === 0);
    } catch(err) {
      showToast('Error reading spreadsheet: ' + err.message, true);
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportData() {
  const blob = new Blob([JSON.stringify(S,null,2)],{type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download=`puzzleboard_${today()}.json`; a.click();
  URL.revokeObjectURL(url);
}

function importClick() { document.getElementById('importFile').click(); }

function importJSON(e) {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const imported = JSON.parse(ev.target.result);
      S = { ...DEFAULTS, ...imported };
      backfillFps();
      save(); renderAdmin();
      showToast('Data imported successfully');
    } catch { alert('Invalid JSON file.'); }
  };
  r.readAsText(file);
}

function confirmClearAll() {
  showConfirm('⚠️','Delete ALL records permanently?',
    `This will permanently delete ${S.entries.length} entries with no export. Members and settings are kept. This cannot be undone.`,
    () => {
      S.entries = [];
      S.awardedMilestones = [];
      save(); renderAdmin(); renderUser();
      showToast('All records deleted permanently');
    }
  );
}

// ── Archive & Reset ─────────────────────────────────────────
function openArchiveModal() {
  const label = document.getElementById('archive-label');
  // Pre-fill a sensible default label based on current month/year
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  label.value = `${months[now.getMonth()]} ${now.getFullYear()}`;

  // Show preview stats
  const preview = document.getElementById('archive-preview');
  const people  = aggregate(S.entries);
  const topRecv = [...people].sort((a,b)=>b.received-a.received)[0];
  preview.innerHTML = `
    <strong style="color:var(--text);">${S.entries.length}</strong> records across
    <strong style="color:var(--text);">${people.length}</strong> participants ·
    <strong style="color:var(--text);">${applyLimit(S.entries).reduce((s,e)=>s+e.count,0)}</strong> total 🧩 given${topRecv ? ` ·
    Top receiver: <strong style="color:var(--accent2);">${topRecv.name.split(' ')[0]}</strong> (${topRecv.received})` : ''}
  `;

  openModal('archiveModal');
  label.focus();
  label.select();
}

function runArchive() {
  const label = document.getElementById('archive-label').value.trim();
  if (!label) { alert('Please enter a label for this period.'); return; }

  // 1. Build the archive snapshot
  const snapshot = {
    label,
    archivedAt: new Date().toISOString(),
    entryCount: S.entries.length,
    members: S.members,
    entries: S.entries,
    settings: {
      channel: S.channel,
      limitEnabled: S.limitEnabled,
      limitPerDay: S.limitPerDay
    }
  };

  // 2. Auto-download the archive file
  const filename = `puzzleboard_archive_${label.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_${today()}.json`;
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);

  // 3. Save a summary reference in archives (not the full data — just metadata)
  if (!S.archives) S.archives = [];
  S.archives.unshift({
    label,
    date: today(),
    entryCount: snapshot.entryCount,
    filename
  });

  // 4. Clear live entries and milestone award log
  S.entries = [];
  S.awardedMilestones = [];

  save();
  closeModal('archiveModal');
  renderAdmin();
  renderUser();
  showToast(`📦 "${label}" archived & reset — ${snapshot.entryCount} records exported`);
}

function renderArchiveList() {
  const el = document.getElementById('a-archive-list');
  if (!el) return;
  const archives = S.archives || [];

  if (archives.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="form-label" style="margin-bottom:8px;margin-top:4px;">Past Archives</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${archives.map((a, i) => `
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:9px 12px;display:flex;align-items:center;gap:10px;">
          <div style="font-size:16px;">📦</div>
          <div style="flex:1;">
            <div style="font-size:12px;font-weight:700;">${a.label}</div>
            <div style="font-size:10px;color:var(--muted);font-family:'DM Mono',monospace;">${a.date} · ${a.entryCount} records</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="deleteArchiveRef(${i})" title="Remove from list">✕</button>
        </div>
      `).join('')}
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px;line-height:1.5;">
      Archive files are on your device. Use ⬆ Import JSON to restore one.
    </div>
  `;
}

function deleteArchiveRef(idx) {
  S.archives.splice(idx, 1);
  save(); renderArchiveList();
  showToast('Archive reference removed');
}

// ═══════════════════════════════════════════════════════════
//  PARSE PASTED MESSAGES
// ═══════════════════════════════════════════════════════════
function parsePasted(rawText) {
  // Normalise first — handles all Teams emoji copy variants
  const text  = normalisePuzzles(rawText);
  const lines   = text.split('\n');
  const results = [];
  let currentSender = null;
  const dateStr = today();
  const nameTimeRe  = /^(.+?)\s{2,}(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*$/i;
  const namePrefixRe= /^([A-Za-z][A-Za-z\s\-'.]{1,30}):\s+(.+)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const ntMatch = line.match(nameTimeRe);
    if (ntMatch && !line.includes('🧩')) { currentSender=ntMatch[1].trim(); continue; }
    const pfMatch = line.match(namePrefixRe);
    const msgText = pfMatch ? (currentSender=pfMatch[1].trim(), pfMatch[2]) : line;
    const count   = (msgText.match(PUZZLE_RE)||[]).length;
    if (count===0) continue;
    const sender  = currentSender||'Unknown';
    let recipient = null;
    // NOT_SURNAME: Title-Case words that follow a name but aren't surnames.
    // Prevents '@Bobblehead Thank you' matching as 'Bobblehead Thank'.
    const NOT_SURNAME = new Set(['Thank','Thanks','You','Your','Please','For','The',
      'And','But','With','Great','Good','Amazing','Awesome','Nice','Well','Done',
      'Job','Work','Happy','Hope','Just','This','That','Here','Today','From','About']);
    const _mRaw = msgText.match(/@([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\-'.]*(?:\s+[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F\-'.]*)?)/u);
    const _mWords = _mRaw ? _mRaw[1].trim().split(/\s+/) : null;
    const mentionMatch = _mRaw ? [_mRaw[0], (_mWords.length === 2 && NOT_SURNAME.has(_mWords[1])) ? _mWords[0] : _mRaw[1].trim()] : null;
    const toMatch      = msgText.match(/\bto\s+([A-Z][A-Za-z\s\-'.]{1,25}?)(?:\s|$|!|\.|,)/);
    const SKIP_RECIPIENTS = new Set(['Team','Unknown','PuzzleBoard','Recognition','Patch']);
    if (mentionMatch)      recipient=mentionMatch[1].trim();
    else if (toMatch)      recipient=toMatch[1].trim();
    else                   recipient='Team';
    if (sender.toLowerCase()===recipient.toLowerCase()) recipient='Team';
    if (SKIP_RECIPIENTS.has(recipient)) recipient='Team';
    // Drop unattributed entries — no @mention means likely a mistake, don't count
    if (recipient === 'Team') continue;
    const note = msgText.replace(PUZZLE_RE, '').replace(/@[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-'.]*(?:\s+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-'.]*)?/gu, '').trim().slice(0, 80);
    const fp   = makeFp(sender, recipient, dateStr, note);
    results.push({ sender, recipient, count, date: dateStr, note, fp });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
//  CONTROLS — period, sort
// ═══════════════════════════════════════════════════════════
// ── Period picker state ────────────────────────────────────
let _pickerYear    = new Date().getFullYear();
let _openPopover   = null;  // 'month' | 'quarter' | null

const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const QUARTERS = ['Q1','Q2','Q3','Q4'];

function setPeriod(btn, val) {
  // Close any open popover
  closeAllPopovers();
  // Deactivate all pills
  document.querySelectorAll('#u-period-group .pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  S.period = val;
  save();
  renderUser();
  updatePeriodLabel();
}

function togglePeriodPopover(type) {
  if (_openPopover === type) {
    closeAllPopovers();
    return;
  }
  closeAllPopovers();
  _openPopover = type;
  _pickerYear  = S.pickerYear || new Date().getFullYear();
  renderPickerGrid(type);
  document.getElementById(`popover-${type}`).classList.add('open');
}

function closeAllPopovers() {
  _openPopover = null;
  document.querySelectorAll('.period-popover').forEach(p => p.classList.remove('open'));
}

function shiftPickerYear(delta) {
  _pickerYear = Math.max(2020, Math.min(new Date().getFullYear(), _pickerYear + delta));
  S.pickerYear = _pickerYear;
  if (_openPopover) renderPickerGrid(_openPopover);
}

function renderPickerGrid(type) {
  // Update both year labels
  const yl  = document.getElementById('picker-year-label');
  const ylq = document.getElementById('picker-year-label-q');
  if (yl)  yl.textContent  = _pickerYear;
  if (ylq) ylq.textContent = _pickerYear;

  const now = new Date();

  if (type === 'month') {
    const grid = document.getElementById('month-grid');
    if (!grid) return;
    grid.innerHTML = MONTHS.map((m, i) => {
      const val       = `month:${_pickerYear}-${String(i+1).padStart(2,'0')}`;
      const isActive  = S.period === val;
      // Disable future months
      const isFuture  = _pickerYear > now.getFullYear() ||
                        (_pickerYear === now.getFullYear() && i > now.getMonth());
      return `<button class="popover-item ${isActive ? 'active' : ''}"
        ${isFuture ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}
        onclick="selectPickerPeriod('${val}','month')">${m}</button>`;
    }).join('');
  }

  if (type === 'quarter') {
    const grid = document.getElementById('quarter-grid');
    if (!grid) return;
    grid.innerHTML = QUARTERS.map((q, i) => {
      const val      = `quarter:${_pickerYear}-${q}`;
      const isActive = S.period === val;
      const qEnd     = (_pickerYear * 100) + ((i+1) * 3); // YYYYMM of last month
      const nowYM    = (now.getFullYear() * 100) + (now.getMonth() + 1);
      const isFuture = qEnd > nowYM;
      return `<button class="popover-item ${isActive ? 'active' : ''}"
        ${isFuture ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}
        onclick="selectPickerPeriod('${val}','quarter')">${q}</button>`;
    }).join('');
  }
}

function selectPickerPeriod(val, type) {
  closeAllPopovers();
  document.querySelectorAll('#u-period-group .pill').forEach(b => b.classList.remove('active'));
  document.getElementById(`pp-${type}`)?.classList.add('active');
  S.period     = val;
  S.pickerYear = _pickerYear;
  save();
  renderUser();
  updatePeriodLabel();
}

function updatePeriodLabel() {
  // Update the Month/Quarter button labels to show current selection
  const p   = S.period || '7d';
  const mBtn = document.getElementById('pp-month');
  const qBtn = document.getElementById('pp-quarter');
  if (mBtn) mBtn.textContent = p.startsWith('month:')   ? periodLabel() + ' ▾' : 'Month ▾';
  if (qBtn) qBtn.textContent = p.startsWith('quarter:') ? periodLabel() + ' ▾' : 'Quarter ▾';
  // Sync active state on plain pills
  ['7d','30d','all'].forEach(id => {
    document.getElementById(`pp-${id}`)?.classList.toggle('active', p === id);
  });
  if (p.startsWith('month:'))   document.getElementById('pp-month')?.classList.add('active');
  if (p.startsWith('quarter:')) document.getElementById('pp-quarter')?.classList.add('active');
  // Update leaderboard subtitle
  const periodEl = document.getElementById('u-period-display');
  if (periodEl) periodEl.textContent = `— ${periodLabel()}`;
  // Sync sort tab active states with S.sort
  ['total','sent','received'].forEach(s => {
    document.getElementById(`st-${s}`)?.classList.toggle('active', S.sort === s);
  });
}

// Close popovers on outside click
document.addEventListener('click', e => {
  if (_openPopover && !e.target.closest('#u-period-group')) closeAllPopovers();
});

function setSort(btn,val) {
  document.querySelectorAll('.sort-tabs .pill').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const search = document.getElementById('lb-search');
  if (search) search.value = '';
  S.sort=val; save(); renderUser();
}

// ═══════════════════════════════════════════════════════════
//  MODAL HELPERS
// ═══════════════════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function maybeClose(e,id) { if(e.target===document.getElementById(id)) closeModal(id); }

function copyPrompt() {
  const prompt = 'Sync Teams participants for PuzzleBoard. Search recent Teams chat messages and return a JSON object like: {"names": ["Full Name", "Full Name"]}. Only return the JSON, no other text.';
  navigator.clipboard.writeText(prompt).then(() => {
    const btn = document.getElementById('copy-prompt-btn');
    btn.textContent = 'Copied!';
    btn.style.color = 'var(--accent3)';
    setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = ''; }, 2000);
  }).catch(() => showToast('Copy failed — select the text manually.', true));
}

// ═══════════════════════════════════════════════════════════
//  CONFIRM DIALOG
// ═══════════════════════════════════════════════════════════
let _confirmCb = null;
function showConfirm(icon, title, msg, cb) {
  document.getElementById('confirm-icon').textContent  = icon;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  _confirmCb = cb;
  document.getElementById('confirmOverlay').classList.add('open');
}
function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('open'); _confirmCb=null; }
document.getElementById('confirm-ok').onclick = ()=>{ if(_confirmCb) _confirmCb(); closeConfirm(); };

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════
let _toastTimer;
function showToast(msg, isError=false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:28px;right:28px;z-index:999;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 18px;font-size:13px;font-weight:700;box-shadow:0 4px 24px rgba(0,0,0,0.4);transition:all 0.25s;opacity:0;transform:translateY(8px);pointer-events:none;max-width:320px;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--danger)' : 'var(--accent)';
  el.style.color = isError ? 'var(--danger)' : 'var(--text)';
  el.style.opacity='1'; el.style.transform='translateY(0)';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(8px)'; },3000);
}

// ═══════════════════════════════════════════════════════════
//  PROFILE DRAWER (banner)
// ═══════════════════════════════════════════════════════════

let _bannerDrawerOpen = false;
let _bannerDrawerTab  = 'recv';

function toggleBannerDrawer() {
  _bannerDrawerOpen = !_bannerDrawerOpen;
  const drawerEl = document.getElementById('banner-drawer');
  const hintEl   = document.getElementById('banner-expand-hint');
  if (!drawerEl) return;
  drawerEl.style.display = _bannerDrawerOpen ? 'block' : 'none';
  if (hintEl) hintEl.textContent = _bannerDrawerOpen ? '▲ My History' : '▼ My History';
  if (_bannerDrawerOpen) renderBannerDrawer(_bannerDrawerTab);
}

function switchBannerTab(event, tab) {
  event.stopPropagation();
  _bannerDrawerTab = tab;
  document.querySelectorAll('.drawer-tab').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderBannerDrawer(tab);
}

function renderBannerDrawer(tab) {
  const el = document.getElementById('banner-drawer-body');
  if (!el || !S.myName) return;
  const personName = S.myName;

  const filtered = filterByPeriod(S.entries);
  const capped   = applyLimit(filtered);

  let entries;
  if (tab === 'recv') {
    entries = capped
      .filter(e => e.recipient === personName)
      .sort((a,b) => b.date.localeCompare(a.date));
  } else {
    entries = capped
      .filter(e => e.sender === personName)
      .sort((a,b) => b.date.localeCompare(a.date));
  }

  if (entries.length === 0) {
    el.innerHTML = `<div class="drawer-empty">No ${tab === 'recv' ? 'received' : 'sent'} pieces in this period.</div>`;
    return;
  }

  el.innerHTML = entries.map(e => {
    const isRecv   = tab === 'recv';
    const pieces   = '🧩'.repeat(Math.min(e.count, 5)) + (e.count > 5 ? `+${e.count-5}` : '');
    const who      = isRecv ? `From <strong>${e.sender}</strong>` : `To <strong>${e.recipient}</strong>`;
    const overLimitDr = buildOverLimitSet().has(e.fp);
    const limitBadgeDr = overLimitDr ? '<span title="Over daily limit — not counted in totals" style="font-size:10px;color:var(--warn);margin-left:4px;">⚠ limit</span>' : '';
    const isBonus  = e.isBonus;
    return `<div class="drawer-entry">
      <div class="drawer-pip ${isBonus ? '' : (isRecv ? 'recv' : 'sent')}" style="${isBonus ? 'background:var(--accent)' : ''}"></div>
      <div class="drawer-body">
        <div class="drawer-who">${who} ${isBonus ? '<span style="font-size:10px;color:var(--accent)">★ Bonus</span>' : ''}</div>
        ${limitBadgeDr}${e.note ? `<div class="drawer-note">"${e.note}"</div>` : ''}
      </div>
      <div class="drawer-right">
        <div class="drawer-count ${isRecv ? 'recv' : 'sent'}">${pieces}</div>
        <div class="drawer-date">${e.date}</div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
//  ADMIN RECORDS MODAL
// ═══════════════════════════════════════════════════════════

let _recordsName  = '';
let _editingRowFp = null;

function openRecordsModal(name) {
  _recordsName  = name;
  _editingRowFp = null;
  document.getElementById('records-modal-title').textContent = `🧩 Records — ${name}`;
  renderRecordsTable();
  openModal('recordsModal');
}

function renderRecordsTable() {
  const el      = document.getElementById('records-table-body');
  const name    = _recordsName;
  const entries = S.entries
    .filter(e => e.sender === name || e.recipient === name)
    .sort((a,b) => b.date.localeCompare(a.date));

  const allMembers  = S.members.map(m => m.name);
  const memberOpts  = allMembers.map(n => `<option value="${n}">${n}</option>`).join('');

  if (entries.length === 0) {
    el.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted);">No records for ${name}</td></tr>`;
    return;
  }

  el.innerHTML = entries.map(e => {
    const direction = e.sender === name ? 'sent' : 'recv';
    const dirLabel  = e.sender === name ? 'Sent' : 'Received';
    const isEditing = _editingRowFp === e.fp;
    const safeFp    = e.fp ? e.fp.replace(/'/g, "\'") : '';
    const isBonus   = e.isBonus;

    if (isEditing) {
      const fromOpts = allMembers.map(n => `<option value="${n}" ${n===e.sender?'selected':''}>${n}</option>`).join('');
      const toOpts   = allMembers.map(n => `<option value="${n}" ${n===e.recipient?'selected':''}>${n}</option>`).join('');
      return `<tr style="background:rgba(124,108,255,0.06)">
        <td><span class="pill-type ${direction}">${dirLabel}</span></td>
        <td><select class="inline-edit-input" id="edit-from" style="min-width:120px;">${fromOpts}</select></td>
        <td><select class="inline-edit-input" id="edit-to" style="min-width:120px;">${toOpts}</select></td>
        <td><input class="inline-edit-input" type="number" id="edit-count" value="${e.count}" min="1" max="99" style="width:60px;" /></td>
        <td><input class="inline-edit-input" type="date" id="edit-date" value="${e.date}" style="width:130px;" /></td>
        <td><input class="inline-edit-input" id="edit-note" value="${(e.note||'').replace(/"/g,'&quot;')}" placeholder="Note…" style="min-width:120px;" /></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-admin btn-sm" onclick="saveRecordEdit('${safeFp}')">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelRecordEdit()">Cancel</button>
        </td>
      </tr>`;
    }

    const pieces = '🧩'.repeat(Math.min(e.count,4)) + (e.count > 4 ? `+${e.count-4}` : '');
    return `<tr>
      <td><span class="pill-type ${isBonus ? 'bonus' : direction}">${isBonus ? 'Bonus' : dirLabel}</span></td>
      <td style="font-weight:700;">${e.sender}</td>
      <td style="color:var(--accent2);font-weight:700;">${e.recipient}</td>
      <td><span style="font-family:'DM Mono',monospace;">${pieces} <span style="color:var(--muted);font-size:10px;">(${e.count})</span></span></td>
      <td style="font-family:'DM Mono',monospace;color:var(--muted);font-size:11px;">${e.date}</td>
      <td style="font-size:11px;color:var(--muted);font-style:italic;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.note||'—'}</td>
      <td style="white-space:nowrap;">
        ${isBonus ? '' : `<button class="btn btn-ghost btn-sm" onclick="startRecordEdit('${safeFp}')">Edit</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteRecord('${safeFp}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function startRecordEdit(fp) {
  _editingRowFp = fp;
  renderRecordsTable();
}

function cancelRecordEdit() {
  _editingRowFp = null;
  renderRecordsTable();
}

function saveRecordEdit(fp) {
  const idx = S.entries.findIndex(e => e.fp === fp);
  if (idx === -1) return;
  const sender    = document.getElementById('edit-from').value;
  const recipient = document.getElementById('edit-to').value;
  const count     = parseInt(document.getElementById('edit-count').value) || 1;
  const date      = document.getElementById('edit-date').value || today();
  const note      = document.getElementById('edit-note').value.trim();
  if (sender === recipient) { alert("Sender and recipient can't be the same."); return; }
  // Regenerate fp for updated entry
  const newFp = makeFp(sender, recipient, date, note);
  S.entries[idx] = { ...S.entries[idx], sender, recipient, count, date, note, fp: newFp };
  _editingRowFp = null;
  save(); renderRecordsTable(); renderAdmin();
  showToast('Record updated');
}

function deleteRecord(fp) {
  const entry = S.entries.find(e => e.fp === fp);
  if (!entry) return;
  showConfirm('🗑️', 'Delete this record?',
    `Remove ${entry.count} 🧩 from ${entry.sender} → ${entry.recipient} on ${entry.date}? This cannot be undone.`,
    () => {
      S.entries = S.entries.filter(e => e.fp !== fp);
      save(); renderRecordsTable(); renderAdmin();
      showToast('Record deleted');
    }
  );
}

// ═══════════════════════════════════════════════════════════
//  MILESTONE ENGINE
// ═══════════════════════════════════════════════════════════

const MILESTONE_YEARS = [1, 5, 10, 15, 20];

// Parse "MM-DD" into { month, day } (1-indexed)
function parseBirthday(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2})-(\d{2})$/);
  if (!m) return null;
  return { month: parseInt(m[1]), day: parseInt(m[2]) };
}

// Days until next occurrence of MM-DD from today (0 = today, up to 365)
function daysUntilMonthDay(month, day) {
  const now = new Date();
  const y   = now.getFullYear();
  const todayMidnight = new Date(y, now.getMonth(), now.getDate());
  let target = new Date(y, month - 1, day);
  if (target < todayMidnight) target = new Date(y + 1, month - 1, day);
  return Math.round((target - todayMidnight) / 86400000);
}

// Parse YYYY-MM-DD safely in local time (avoids UTC-offset date shift)
function parseLocalDate(str) {
  if (!str) return null;
  const parts = str.split('-');
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

// Years completed since a YYYY-MM-DD date as of today (-1 if invalid)
// e.g. hired exactly 5 years ago today → 5; hired 4y 364d ago → 4
function yearsSince(dateStr) {
  if (!dateStr) return -1;
  const hire = parseLocalDate(dateStr);
  if (!hire) return -1;
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let years = today.getFullYear() - hire.getFullYear();
  // Step back if this year's anniversary hasn't happened yet
  const annivThisYear = new Date(today.getFullYear(), hire.getMonth(), hire.getDate());
  if (annivThisYear > today) years--;
  return years; // 0 means < 1 full year
}

// Days until next anniversary of a YYYY-MM-DD hire date
function daysUntilAnniversary(dateStr) {
  if (!dateStr) return -1;
  const hire = parseLocalDate(dateStr);
  if (!hire) return -1;
  return daysUntilMonthDay(hire.getMonth() + 1, hire.getDate());
}

// Unique key to prevent double-awarding on same calendar day
function milestoneKey(name, type, year) {
  return `${name}|${type}|${year}|${today()}`;
}

function alreadyAwarded(name, type, year) {
  return (S.awardedMilestones || []).some(a =>
    a.name === name && a.type === type && a.year === year && a.date === today()
  );
}

function recordAward(name, type, year) {
  if (!S.awardedMilestones) S.awardedMilestones = [];
  S.awardedMilestones.push({ name, type, year, date: today() });
}

// Award bonus pieces as a system entry
function awardMilestoneBonus(name, count, note) {
  const fp = makeFp('Patch', name, today(), note);
  // Check fp dedup too
  if (S.entries.some(e => e.fp === fp)) return;
  S.entries.push({ sender: 'Patch', recipient: name, count, date: today(), note, fp, isBonus: true });
}

// Run the milestone check — called on load and on admin view switch
function processMilestones() {
  if (!S.birthdayEnabled && !S.anniversaryEnabled) return;
  let changed = false;

  S.members.forEach(m => {
    // ── Birthday ──
    if (S.birthdayEnabled && m.birthday) {
      const bd = parseBirthday(m.birthday);
      if (bd) {
        const days = daysUntilMonthDay(bd.month, bd.day);
        if (days === 0 && !alreadyAwarded(m.name, 'birthday', 0)) {
          awardMilestoneBonus(m.name, S.birthdayBonus, `🎂 Birthday bonus!`);
          recordAward(m.name, 'birthday', 0);
          changed = true;
        }
      }
    }

    // ── Work Anniversary ──
    if (S.anniversaryEnabled && m.hireDate) {
      const days  = daysUntilAnniversary(m.hireDate);
      const years = yearsSince(m.hireDate); // completed years as of today
      if (days === 0 && years >= 1 && !alreadyAwarded(m.name, 'anniversary', years)) {
        const isMilestone = MILESTONE_YEARS.includes(years);
        const bonus = S.anniversaryBonus + (isMilestone ? S.milestoneBonus : 0);
        const note  = isMilestone
          ? `🏆 ${years}-Year Milestone bonus!`
          : `🎉 ${years}-Year Work Anniversary bonus!`;
        awardMilestoneBonus(m.name, bonus, note);
        recordAward(m.name, 'anniversary', years);
        changed = true;
      }
    }
  });

  if (changed) save();
}

// Build the milestone notification data for the UI (today + next 7 days)
function getMilestoneNotifications() {
  const todayItems     = [];
  const upcomingItems  = [];

  S.members.forEach(m => {
    // ── Birthday ──
    if (m.birthday) {
      const bd = parseBirthday(m.birthday);
      if (bd) {
        const days = daysUntilMonthDay(bd.month, bd.day);
        // Format display date for birthday (e.g. "Jun 15")
        const bdMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const bdDateStr = `${bdMonths[bd.month-1]} ${bd.day}`;
        const item = {
          type: 'birthday',
          name: m.name,
          icon: '🎂',
          label: 'Birthday',
          desc: `Happy Birthday, ${m.name.split(' ')[0]}! 🎉`,
          bonus: S.birthdayEnabled ? S.birthdayBonus : 0,
          days,
          isMilestone: false,
          years: null,
          dateStr: bdDateStr
        };
        if (days === 0)       todayItems.push(item);
        else if (days <= 7)   upcomingItems.push(item);
      }
    }

    // ── Anniversary ──
    if (m.hireDate) {
      const days         = daysUntilAnniversary(m.hireDate);
      const completedYrs = yearsSince(m.hireDate);
      // years = the anniversary being celebrated (completed or upcoming)
      const years = days === 0 ? completedYrs : completedYrs + 1;
      if (years < 1) return; // hire date is in the future or < 1 year and anniv not today
      const isMilestone = MILESTONE_YEARS.includes(years);
      const bonus = S.anniversaryEnabled
        ? S.anniversaryBonus + (isMilestone ? S.milestoneBonus : 0)
        : 0;
      // Format display date for anniversary (e.g. "Jun 3")
      const hireLocal = parseLocalDate(m.hireDate);
      const annMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const annDateStr = hireLocal ? `${annMonths[hireLocal.getMonth()]} ${hireLocal.getDate()}` : '';
      const item = {
        type: isMilestone ? 'milestone-year' : 'anniversary',
        name: m.name,
        icon: isMilestone ? '🏆' : '🎉',
        label: isMilestone ? `${years}-Year Milestone` : `${years}-Year Anniversary`,
        desc: isMilestone
          ? `${m.name.split(' ')[0]} is hitting ${years} years — a huge milestone! 🌟`
          : `${m.name.split(' ')[0]} celebrates ${years} year${years !== 1 ? 's' : ''} with the team.`,
        bonus,
        days,
        isMilestone,
        years,
        dateStr: annDateStr
      };
      if (days === 0)      todayItems.push(item);
      else if (days <= 7)  upcomingItems.push(item);
    }
  });

  // Sort upcoming by days away
  upcomingItems.sort((a, b) => a.days - b.days);
  return { todayItems, upcomingItems };
}

function renderMilestoneCard(item) {
  const typeClass  = item.type === 'birthday' ? 'birthday' : item.isMilestone ? 'milestone-year' : 'anniversary';
  const badgeClass = item.type === 'birthday' ? 'birthday-badge' : item.isMilestone ? 'milestone-badge-yr' : 'anniversary-badge';
  const accentColor = item.type === 'birthday' ? 'var(--birthday)' : item.isMilestone ? 'var(--milestone)' : 'var(--anniversary)';

  const dateLabel = item.dateStr ? `<span style="font-size:10px;font-family:'DM Mono',monospace;color:var(--muted);margin-left:4px;">${item.dateStr}</span>` : '';
  const daysLabel = item.days > 0 ? `<span style="font-size:10px;color:var(--muted);white-space:nowrap;">in ${item.days}d</span>` : `<span style="font-size:10px;color:${accentColor};font-weight:700;">Today!</span>`;
  const bonusLabel = item.bonus > 0 ? `<span style="font-size:11px;font-weight:800;color:${accentColor};white-space:nowrap;">+${item.bonus}🧩</span>` : '';

  const msImg = item.type === 'birthday'
    ? 'birthday_mascot.png'
    : 'milestone_mascot.png';
  return `<div class="milestone-card ${typeClass} ${item.days > 0 ? 'upcoming' : ''}" style="margin-bottom:6px;">
    <div class="milestone-icon"><img src="${msImg}" alt="" style="width:32px;height:auto;"></div>
    <div class="milestone-body" style="min-width:0;">
      <div class="milestone-name" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
        ${item.name}${dateLabel}
      </div>
      <div class="milestone-desc">${item.label}</div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;">
      ${daysLabel}
      ${bonusLabel}
    </div>
  </div>`;
}

function renderMilestones() {
  const section = document.getElementById('u-milestone-section');
  if (!section) return;

  const { todayItems, upcomingItems } = getMilestoneNotifications();
  const hasAny = todayItems.length > 0 || upcomingItems.length > 0;

  section.style.display = hasAny ? '' : 'none';
  if (!hasAny) return;

  // Split by type
  const annToday     = todayItems.filter(i => i.type !== 'birthday');
  const bdayToday    = todayItems.filter(i => i.type === 'birthday');
  const annUpcoming  = upcomingItems.filter(i => i.type !== 'birthday');
  const bdayUpcoming = upcomingItems.filter(i => i.type === 'birthday');

  // Anniversary / Milestone column
  const annTodayEl    = document.getElementById('ms-ann-today');
  const annUpcomingEl = document.getElementById('ms-ann-upcoming');
  const annTodayLbl   = document.getElementById('ms-ann-today-label');
  const annUpcomingLbl= document.getElementById('ms-ann-upcoming-label');
  const annEmpty      = document.getElementById('ms-ann-empty');

  annTodayEl.innerHTML    = annToday.map(renderMilestoneCard).join('');
  annUpcomingEl.innerHTML = annUpcoming.map(renderMilestoneCard).join('');
  annTodayLbl.style.display    = annToday.length    ? '' : 'none';
  annUpcomingLbl.style.display = annUpcoming.length ? '' : 'none';
  annEmpty.style.display = (annToday.length === 0 && annUpcoming.length === 0) ? '' : 'none';

  // Birthday column
  const bdayTodayEl    = document.getElementById('ms-bday-today');
  const bdayUpcomingEl = document.getElementById('ms-bday-upcoming');
  const bdayTodayLbl   = document.getElementById('ms-bday-today-label');
  const bdayUpcomingLbl= document.getElementById('ms-bday-upcoming-label');
  const bdayEmpty      = document.getElementById('ms-bday-empty');

  bdayTodayEl.innerHTML    = bdayToday.map(renderMilestoneCard).join('');
  bdayUpcomingEl.innerHTML = bdayUpcoming.map(renderMilestoneCard).join('');
  bdayTodayLbl.style.display    = bdayToday.length    ? '' : 'none';
  bdayUpcomingLbl.style.display = bdayUpcoming.length ? '' : 'none';
  bdayEmpty.style.display = (bdayToday.length === 0 && bdayUpcoming.length === 0) ? '' : 'none';
}

// Admin toggle helper for milestone toggles
function adminToggle(key, btnId) {
  S[key] = !S[key];
  document.getElementById(btnId).classList.toggle('on', S[key]);
  save(); renderAdmin();
}

// ═══════════════════════════════════════════════════════════
//  SEED DEMO DATA
// ═══════════════════════════════════════════════════════════
function seedDemo() {
  const d=n=>new Date(Date.now()-n*86400000).toISOString().split('T')[0];
  const todayMMDD = new Date().toLocaleDateString('en-US',{month:'2-digit',day:'2-digit'}).replace('/','-');
  // Build hire dates that land exactly on today's month/day N years ago
  // so yearsSince() = N and daysUntilAnniversary() = 0 (shows today tile)
  function hireDateYearsAgo(n) {
    const d = new Date();
    return `${d.getFullYear()-n}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  const hire1yr = hireDateYearsAgo(1);
  const hire5yr = hireDateYearsAgo(5);
  const hire2yr = hireDateYearsAgo(2);
  S.members = [
    {name:'Kyle Mitchell',  title:'CX Operations',   birthday:null,       hireDate:hire2yr,   addedAt:d(30)},
    {name:'Sarah Johnson',  title:'Support Engineer', birthday:todayMMDD, hireDate:hire5yr,   addedAt:d(30)},
    {name:'Maria Chen',     title:'Customer Success', birthday:'03-22',  hireDate:'2023-01-10', addedAt:d(30)},
    {name:'James Wright',   title:'Tech Support',     birthday:'11-05',  hireDate:'2022-06-01', addedAt:d(30)},
    {name:'Alex Torres',    title:'QA Analyst',       birthday:'07-19',  hireDate:null,      addedAt:d(30)},
    {name:'Jordan Lee',     title:'Support Manager',  birthday:'09-30',  hireDate:hire1yr,  addedAt:d(30)},
  ];
  S.entries = [
    {sender:'Kyle Mitchell', recipient:'Sarah Johnson', count:3,date:d(0),note:'Crushed the Q2 deck 🚀'},
    {sender:'Sarah Johnson', recipient:'Maria Chen',    count:2,date:d(0),note:'Great onboarding docs'},
    {sender:'Maria Chen',    recipient:'Kyle Mitchell', count:2,date:d(0),note:''},
    {sender:'James Wright',  recipient:'Alex Torres',   count:1,date:d(0),note:'Fast turnaround'},
    {sender:'Alex Torres',   recipient:'Jordan Lee',    count:3,date:d(1),note:''},
    {sender:'Kyle Mitchell', recipient:'James Wright',  count:2,date:d(1),note:'Excellent code review'},
    {sender:'Jordan Lee',    recipient:'Sarah Johnson', count:4,date:d(1),note:'Best retro facilitator'},
    {sender:'Sarah Johnson', recipient:'Alex Torres',   count:1,date:d(2),note:''},
    {sender:'Maria Chen',    recipient:'Jordan Lee',    count:3,date:d(2),note:'Always helpful in standup'},
    {sender:'Kyle Mitchell', recipient:'Maria Chen',    count:2,date:d(3),note:'Runbook was perfect'},
    {sender:'James Wright',  recipient:'Sarah Johnson', count:2,date:d(4),note:''},
    {sender:'Alex Torres',   recipient:'Kyle Mitchell', count:1,date:d(5),note:'Great Zendesk config'},
    {sender:'Jordan Lee',    recipient:'James Wright',  count:2,date:d(6),note:'Solid deployment'},
    {sender:'Sarah Johnson', recipient:'Kyle Mitchell', count:3,date:d(7),note:'ELT dashboard was 🔥'},
  ];
  S.channel='kudos'; S.pin='123456'; S.limitEnabled=false; S.limitPerDay=5;
  save();
}

// ═══════════════════════════════════════════════════════════
//  PASTE INTERCEPTOR — Teams emoji clipboard fix
// ═══════════════════════════════════════════════════════════
// Teams copies emoji as <img alt="🧩"> in its HTML clipboard format.
// Browsers may sanitize clipboard HTML before exposing it to paste event
// handlers on <textarea> elements. To work around this we:
//   1. Always preventDefault on the textarea paste event
//   2. Try to read text/html from clipboardData (works in Chrome/Edge)
//   3. If that's sanitized/empty, redirect the paste into a hidden
//      contenteditable div which receives full rich HTML, read innerHTML
//      from there, then run normalisePuzzles on it.
function initPasteInterceptor() {
  const ta = document.getElementById('a-paste-import');
  if (!ta) { console.warn('[PuzzleBoard] paste interceptor: textarea not found'); return; }
  console.log('[PuzzleBoard] paste interceptor attached');

  // Hidden contenteditable sink — receives raw rich HTML that browsers
  // would otherwise sanitize before delivering to a <textarea>.
  const sink = document.createElement('div');
  sink.contentEditable = 'true';
  sink.setAttribute('aria-hidden', 'true');
  sink.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  document.body.appendChild(sink);

  function insertIntoTextarea(text) {
    const start  = ta.selectionStart;
    const end    = ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const after  = ta.value.slice(end);
    ta.value = before + text + after;
    ta.selectionStart = ta.selectionEnd = start + text.length;
    previewPasteCount(ta.value);
    ta.focus();
  }

  ta.addEventListener('paste', function(e) {
    e.preventDefault();

    const html  = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');

    // Strategy 1: HTML is on the clipboard (Teams always provides this).
    // normalisePuzzles handles <img alt="🧩"> → 🧩 and strips remaining tags.
    // This also works for plain pastes where the browser wraps text in basic HTML.
    if (html) {
      const normalised = normalisePuzzles(html).trim();
      // If normalisation produced something useful, use it.
      // Fall back to plain text if normalisePuzzles returned empty (e.g. HTML-only content with no text).
      insertIntoTextarea(normalised || plain.trim());
      return;
    }

    // Strategy 2: no HTML on clipboard at all — use plain text directly.
    // normalisePuzzles still handles shortcode variants like :puzzle_piece:
    if (plain) {
      insertIntoTextarea(normalisePuzzles(plain).trim());
      return;
    }

    // Strategy 3: neither HTML nor plain text — try the contenteditable sink.
    // This handles edge cases where the browser refuses to expose clipboard data
    // to the paste event handler on a textarea.
    sink.innerHTML = '';
    sink.focus();
    setTimeout(() => {
      const sinkHTML = sink.innerHTML;
      sink.innerHTML = '';
      ta.focus();
      insertIntoTextarea(sinkHTML ? normalisePuzzles(sinkHTML).trim() : '');
    }, 0);
  });
}

// ═══════════════════════════════════════════════════════════
//  KUDOS SPOTLIGHT
// ═══════════════════════════════════════════════════════════
let _spotlightIdx      = 0;
let _spotlightTimer    = null;
let _spotlightPaused   = false;
let _spotlightEntries  = [];
const SPOTLIGHT_INTERVAL = 5000; // ms per card

function buildSpotlightEntries() {
  // Use capped entries with a note, sorted newest first, limit 20
  const capped = applyLimit(S.entries);
  return capped
    .filter(e => e.note && e.note.trim())
    .map((e, i) => ({...e, _idx: i}))
    .sort((a,b) => b.date.localeCompare(a.date) || b._idx - a._idx)
    .slice(0, 20);
}

function renderSpotlight(entries, idx) {
  const card     = document.getElementById('u-spotlight-card');
  const textEl   = document.getElementById('spotlight-text');
  const metaEl   = document.getElementById('spotlight-meta');
  const mascot   = document.getElementById('spotlight-mascot');
  const progress = document.getElementById('spotlight-progress');
  if (!card || !entries.length) {
    if (card) card.style.display = 'none';
    return;
  }
  card.style.display = 'flex';
  const e = entries[idx % entries.length];
  // Fade out
  [textEl, metaEl, mascot].forEach(el => el && (el.style.opacity = '0'));
  setTimeout(() => {
    if (textEl) textEl.textContent = '"' + e.note + '"';
    if (metaEl) {
      metaEl.innerHTML = e.isBonus
        ? `<img src="celebration_mascot.png" style="width:14px;height:auto;vertical-align:middle;margin-right:4px;">Patch → <strong>${e.recipient}</strong>`
        : `From <strong>${e.sender}</strong> → <strong>${e.recipient}</strong> · ${e.date}`;
    }
    if (mascot) mascot.src = e.isBonus ? 'celebration_mascot.png' : 'mascot_happy.png';
    // Fade in
    [textEl, metaEl, mascot].forEach(el => el && (el.style.opacity = '1'));
    // Reset progress bar animation
    if (progress) {
      progress.style.transition = 'none';
      progress.style.transform = 'scaleX(1)';
      requestAnimationFrame(() => {
        progress.style.transition = `transform ${SPOTLIGHT_INTERVAL}ms linear`;
        progress.style.transform = 'scaleX(0)';
      });
    }
  }, 400);
}

function startSpotlight() {
  const card = document.getElementById('u-spotlight-card');
  if (!card) return;
  _spotlightEntries = buildSpotlightEntries();
  if (!_spotlightEntries.length) { card.style.display = 'none'; return; }
  renderSpotlight(_spotlightEntries, _spotlightIdx);
  clearInterval(_spotlightTimer);
  _spotlightTimer = setInterval(() => {
    if (_spotlightPaused) return;
    _spotlightIdx = (_spotlightIdx + 1) % _spotlightEntries.length;
    renderSpotlight(_spotlightEntries, _spotlightIdx);
  }, SPOTLIGHT_INTERVAL);
  // Pause on hover
  card.onmouseenter = () => { _spotlightPaused = true; };
  card.onmouseleave = () => { _spotlightPaused = false; };
}

// ═══════════════════════════════════════════════════════════
//  INIT — async so persistent storage can be awaited
// ═══════════════════════════════════════════════════════════
(async () => {
  // Render immediately so the loading state shows while Supabase fetches
  renderUser();
  setRefreshSpinning(true);
  const initialLoadOk = await loadState();
  setRefreshSpinning(false);
  // Only seed demo data if Supabase connected and genuinely returned empty state
  // Don't seed if Supabase was unreachable — real data may exist but be temporarily inaccessible
  if (S.entries.length === 0 && S.members.length === 0 && initialLoadOk) seedDemo();
  backfillFps();
  processMilestones(); // award any due bonuses before first render
  // Apply admin-configured defaults on every load
  S.period = resolveDefaultPeriod(S.defaultPeriod || '7d');
  S.sort   = S.defaultSort || 'received';
  S.myName = ''; // never persist identity — always prompt fresh
  renderUser();
  // Wire up the Teams clipboard paste interceptor for the admin import textarea.
  // Uses DOMContentLoaded as a safety net in case the textarea isn't in the DOM yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPasteInterceptor);
  } else {
    initPasteInterceptor();
  }
  // Prompt identity after a short delay so the board renders first
  // Skip identity modal if there are no members — nothing to select and it's confusing
  setTimeout(() => { if (S.members.length > 0) openIdentityModal(); }, 400);
})();