# PuzzleBoard — Project Context

Use this document as the system prompt / project instructions when continuing
PuzzleBoard work in a Claude Project. Paste it into the Project's custom
instructions field so Claude has full context without re-explanation.

---

## What PuzzleBoard Is

PuzzleBoard is a HeyTaco-style recognition leaderboard built for the
Togetherwork CX Operations team. It tracks 🧩 puzzle piece emoji given
between team members as a recognition currency, shows a ranked leaderboard,
and surfaces birthday/work anniversary milestones with automatic bonus awards.

It is a **single-page web application** — no backend, no server. All state
lives in browser persistent storage (artifact storage API → localStorage
fallback). It is currently delivered as a single HTML artifact in Claude.ai
but the files have been split for project work (see File Structure below).

---

## File Structure

```
puzzleboard_index.html   — Main HTML shell (references CSS and JS externally)
puzzleboard.css          — All styles (~865 lines, CSS custom properties for theming)
puzzleboard.js           — All application logic (~2,170 lines)
puzzleboard.html         — Self-contained single-file version (source of truth)
```

The single-file `puzzleboard.html` is the **source of truth**. When making
changes always edit that file. The split files are for deployment reference.

---

## Two Views

### User View (default)
- Identity prompt on every load (modal, searchable, can't be skipped)
- Period filter: 7D / 30D / Month picker / Quarter picker / All
- Sort: Most Received (default) / Most Sent / Total
- My Status banner (expands to show sent/received history per person)
- Milestone notification tiles (birthdays + anniversaries, two columns)
- Leaderboard with sent/received dual bars per person
- Today's Pulse panel + Recent Activity feed

### Admin View (PIN-protected)
- Default PIN: `1234` (configurable in Settings tab)
- Access via 🔐 button in user header → PIN pad

**People tab:**
- Participant list with search bar
- Add Person (manual, with birthday MM-DD + hire date YYYY-MM-DD)
- Import from File (CSV / XLSX via SheetJS — maps columns, previews, deduplicates)
- Sync from Teams (two-step: copy Claude prompt → paste JSON response)
- Per-member: 📋 Records modal (view/edit/delete individual entries), Edit, Remove

**Settings tab:**
- Daily Send Limit (toggle + configurable cap; bonus entries are exempt)
- Birthdays & Anniversaries (toggle each, set bonus piece counts, milestone years)
- Board Settings (channel name, PIN, Default View — period + sort)
- Data Management (paste import, JSON import/export, Archive & Reset, Clear All)

---

## Data Model

All state lives in a single object `S` persisted to storage under key
`puzzleboard-state`. Shape:

```js
S = {
  // Core data
  entries: [{ sender, recipient, count, date, note, fp, isBonus? }],
  members: [{ name, title, birthday, hireDate, addedAt }],
  archives: [{ label, date, entryCount, filename }],
  awardedMilestones: [{ name, type, year, date }],

  // Auth
  pin: '1234',

  // Board config
  channel: 'kudos',
  defaultPeriod: '7d',   // applied on every load
  defaultSort: 'received',

  // Runtime (reset on load to defaults)
  period: '7d',          // '7d'|'30d'|'month:YYYY-MM'|'quarter:YYYY-Q#'|'all'
  sort: 'received',      // 'total'|'sent'|'received'
  myName: '',            // cleared on load — always re-prompted
  pickerYear: 2025,

  // Milestone config
  birthdayEnabled: true,
  birthdayBonus: 5,
  anniversaryEnabled: true,
  anniversaryBonus: 3,
  milestoneYears: [1,5,10,15,20],
  milestoneBonus: 10,

  // Daily limit
  limitEnabled: false,
  limitPerDay: 5,
}
```

**Entry fingerprint (fp):** FNV-1a hash of `sender|recipient|date|note`.
Used for deduplication — paste imports check against all existing fps before
inserting. Manual entries are also fingerprinted on creation.

---

## Key Functions Reference

| Function | Purpose |
|---|---|
| `renderUser()` | Rebuild entire user view |
| `renderAdmin()` | Rebuild entire admin view |
| `filterByPeriod(entries)` | Apply current S.period to an entry array |
| `applyLimit(entries)` | Apply daily send cap (bonus entries exempt) |
| `aggregate(entries)` | Produce per-person {sent, received, total} |
| `parsePasted(text)` | Parse Teams-pasted text → entry objects |
| `normalisePuzzles(text)` | Convert all Teams emoji variants → 🧩 |
| `dedupEntries(parsed)` | Filter out already-recorded entries by fp |
| `processMilestones()` | Award birthday/anniversary bonuses for today |
| `renderMilestones()` | Populate milestone notification tiles |
| `resolveDefaultPeriod(raw)` | Convert 'month:current' etc. → concrete value |
| `setPeriod(btn, val)` | Change active period + re-render |
| `setSort(btn, val)` | Change active sort + re-render |
| `toggleBannerDrawer()` | Expand/collapse My History in banner |
| `openRecordsModal(name)` | Admin: open per-person entry editor |
| `runArchive()` | Export snapshot + clear entries |
| `fiRunImport()` | Commit file import results to S.members |

---

## External Dependencies

| Library | Version | Used for |
|---|---|---|
| Google Fonts (Syne + DM Mono) | CDN | Typography |
| SheetJS (xlsx) | 0.18.5 cdnjs | Excel file parsing in Import from File |

No npm, no build step. Pure HTML/CSS/JS.

---

## Planned / In Progress

- **Power Automate flow** — watches Teams kudos channel, detects 🧩 messages,
  writes to Excel on SharePoint. Flow config written; pending setup by Kyle.
  When complete: Admin → Data Management → Import from File will consume the
  Excel output directly as transaction records (not just member names).
- **Excel log import as entries** — the file importer currently handles members
  only. A future update should detect Sender/Recipient/PuzzleCount/Date columns
  and import them as puzzle piece entries directly.

---

## Conventions for Continued Development

- Always run `node --check` on extracted JS before presenting
- Python script pattern for extraction and syntax check:
  ```python
  import re, subprocess, tempfile, os
  content = open('puzzleboard.html').read()
  script = re.search(r'<script>(.*?)</script>', content, re.DOTALL).group(1)
  with tempfile.NamedTemporaryFile(suffix='.mjs', mode='w', delete=False) as f:
      f.write(script); fname = f.name
  result = subprocess.run(['node', '--check', fname], capture_output=True, text=True)
  print('STDERR:', result.stderr[:400] if result.stderr else 'NONE — CLEAN')
  os.unlink(fname)
  ```
- Use Python string replacement (`str.replace`) for surgical edits;
  avoid regex on HTML/JS to prevent escape corruption
- Line-based replacement (`lines[idx] = ...`) when string match fails
- CSS variables are defined in `:root` — always use vars, never hardcode colors
- All new state fields must be added to `DEFAULTS` with a sensible default
- `save()` must be called after any mutation to `S`
- `renderUser()` and `renderAdmin()` are full redraws — keep them idempotent
