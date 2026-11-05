# Milestone design system

Milestone holds a client's money and releases it to a freelancer when the work is verified. Every screen should make one
thing obvious: **where the money is right now and what moves it next.** The interface is an instrument, not a dashboard
template. Dark ink is the primary theme; the light theme is warm paper, designed on its own terms, not an inversion.

Follow this file to the letter. If something you need is not here, use the closest primitive and leave a `// DESIGN:` comment
explaining the gap rather than inventing a new style.

Reference implementations: `src/app/layout.tsx` (header, wordmark, role switcher) and `src/app/page.tsx` (the contract ledger).
Copy their structure.

---

## 1. Tokens

All tokens live in `src/app/globals.css`. Use them through Tailwind classes (names below) or `var(--token)`. Never write a raw hex
value, a `zinc-*`/`slate-*`/`gray-*` class, or a Tailwind palette colour (`emerald-500`, `violet-400`, ...) in a component.

### 1.1 Surfaces and ink

| Token (CSS var)       | Tailwind class            | Dark (primary)              | Light (paper)               | Use |
|-----------------------|---------------------------|-----------------------------|-----------------------------|-----|
| `--bg`                | `bg-bg`                   | `#0b0d12`                   | `#f4f2ed`                   | Page background. Only on `body`. |
| `--bg-deep`           | `bg-bg-deep`              | `#07080c`                   | `#ebe8e1`                   | Footer band, behind sunken wells. |
| `--surface`           | `bg-surface`              | `#11141b`                   | `#fbfaf7`                   | Opaque panel (inside grids, popovers). |
| `--surface-glass`     | `bg-surface-glass`        | `rgb(20 24 33 / .62)`       | `rgb(255 255 255 / .68)`    | Default panel (with `backdrop-blur`). Use `<Panel>`. |
| `--surface-raised`    | `bg-surface-raised`       | `#171b24`                   | `#ffffff`                   | Hover row, pressed segment, raised key. |
| `--surface-sunken`    | `bg-surface-sunken`       | `#080a0e`                   | `#ebe8e1`                   | Wells: log streams, role-switcher track, inputs. |
| `--paper`             | `bg-paper`                | `#15161b`                   | `#fffdf7`                   | Receipts only. |
| `--hairline`          | `border-hairline`         | `rgb(255 255 255 / .07)`    | `rgb(20 22 30 / .10)`       | Every 1px border and divider. |
| `--hairline-strong`   | `border-hairline-strong`  | `rgb(255 255 255 / .13)`    | `rgb(20 22 30 / .18)`       | Hover/focus borders, input borders. |
| `--highlight`         | (used by `.glass`)        | `rgb(255 255 255 / .05)`    | `rgb(255 255 255 / .85)`    | 1px inset top highlight on glass. |
| `--fg`                | `text-fg`                 | `#eceef3`                   | `#12141a`                   | Primary text, numbers. |
| `--fg-muted`          | `text-fg-muted`           | `#a0a7b8`                   | `#484d5b`                   | Secondary text, counterparties. |
| `--fg-faint`          | `text-fg-faint`           | `#7c8393`                   | `#636670`                   | Labels, ids, timestamps, currency symbols. |
| `--fg-inverse`        | `text-fg-inverse`         | `#0b0d12`                   | `#f6f5f1`                   | Text on a primary button. |
| `--focus`             | `ring-focus`/`outline-focus` | `#9db8ff`                | `#2d5bd7`                   | Focus ring, 2px outline, 2px offset. |

### 1.2 State colours (the only accents)

Every accent on screen means a state. One CSS var per state, plus a `data-tone` attribute that sets `--tone` for any subtree.

| State key             | Tone key   | Var                 | Tailwind               | Dark      | Light     | Meaning |
|-----------------------|------------|---------------------|------------------------|-----------|-----------|---------|
| `draft`               | `draft`    | `--state-draft`     | `text-state-draft`     | `#8e95a8` | `#616779` | Not funded. |
| `funded`              | `funded`   | `--state-funded`    | `text-state-funded`    | `#5ea8ff` | `#1a65c4` | Money captured, held for this milestone. Cool blue. |
| `verifying`           | `verifying`| `--state-verifying` | `text-state-verifying` | `#a98bff` | `#6a43e0` | Agent is checking. Violet, shimmers. The only animated-by-default state. |
| `review`              | `review`   | `--state-review`    | `text-state-review`    | `#3fd2c7` | `#09736e` | Verified; client review window counting down. Teal. |
| `released`            | `released` | `--state-released`  | `text-state-released`  | `#3ee08f` | `#0f7641` | Paid out, confirmed by PayPal webhook. Confident green. |
| `partial_released`    | `partial`  | `--state-partial`   | `text-state-partial`   | `#a6e35b` | `#4a720e` | Share paid, rest refunded. |
| `held`                | `held`     | `--state-held`      | `text-state-held`      | `#f6a53c` | `#9b5408` | Stopped. Side track. Amber. |
| `needs_client`        | `needs`    | `--state-needs`     | `text-state-needs`     | `#ffc94d` | `#875f00` | Waiting on the client. Side track. Light amber. |
| (failures, operator)  | `danger`   | `--state-danger`    | `text-state-danger`    | `#ff6b7a` | `#c02d40` | Failed payout, injection, destructive buttons. |

Contract statuses reuse them: `draft` -> draft, `approved` -> funded (hollow glyph), `active` -> funded, `closed` -> released.
The mapping lives in `src/components/ui/states.ts` (`STATE_META`, `toneOf(status)`); never re-map in a screen.

Derived fills, always via the utilities below, never hand-mixed:

| Utility           | Value |
|-------------------|-------|
| `text-tone`       | `color: var(--tone)` |
| `bg-tone-soft`    | tone at 10% over transparent |
| `bg-tone-wash`    | tone at 5% (row highlight) |
| `border-tone`     | tone at 38% |
| `glow-tone`       | `0 0 0 1px` tone 30% + 0 0 18px tone 22%. Only on the current rail station and a live dot. |

Set the tone with `data-tone="review"` (tone key) on any ancestor.

### 1.3 Type

| Role        | Font (var)                         | Class               | Size / line height | Use |
|-------------|------------------------------------|---------------------|--------------------|-----|
| Display XL  | Instrument Serif 400 (`--font-display`) | `type-display-xl` | 56/1.0 (40 on mobile), tracking -0.01em | One per page max: page titles. |
| Display L   | Instrument Serif                   | `type-display-l`    | 40/1.05 (32 mobile) | Page title when there is a big stat beside it. |
| Display M   | Instrument Serif                   | `type-display-m`    | 28/1.1             | Panel titles, milestone titles on the rail. |
| Display S   | Instrument Serif                   | `type-display-s`    | 22/1.15            | Ledger row titles, receipt headings. |
| Body        | Geist (`--font-sans`)              | default             | 15/1.55            | Running text. |
| Small       | Geist                              | `text-[13px]`       | 13/1.45            | Secondary lines. |
| Label       | Geist Mono (`--font-mono`)         | `type-label`        | 11/1.2, uppercase, tracking 0.12em | Eyebrows, column heads, stat labels. |
| Num XL      | Geist Mono, tabular                | `type-num-xl`       | 48/1.0, tracking -0.03em | Instrument-panel figures. |
| Num L       | Geist Mono, tabular                | `type-num-l`        | 32/1.05, tracking -0.02em | Stat values. |
| Num M       | Geist Mono, tabular                | `type-num-m`        | 20/1.1             | Row totals. |
| Num S       | Geist Mono, tabular                | `type-num-s`        | 14/1.3             | Inline amounts, ids, hashes. |

Rules: every amount, id, hash, timestamp, count and percentage is Geist Mono with `tabular` (use `<Money>`, `<Hash>`, `tabular`).
Serif is only for titles and the wordmark, never for buttons, labels or numbers. Italic serif is used once in the product, on the 404 title
(`<em>`); page titles are plain. No `font-bold` anywhere; max weight is `font-medium` (500) for sans, serif stays 400.

### 1.4 Spacing, radii, layout

- Spacing scale (Tailwind units): 1 (4px), 2 (8), 3 (12), 4 (16), 5 (20), 6 (24), 8 (32), 12 (48), 16 (64).
  Panel padding `p-5 sm:p-6`. Row padding `px-4 py-4 sm:px-5`. Gap between sections `mt-12`. Gap inside a panel `gap-4`.
- Content width: `max-w-content` (1100px), side gutter `px-4 sm:px-6`. Already applied by the layout; pages must not add their own max width.
- Radii: `rounded-chip` 4px (pills, chips, hashes, kbd), `rounded-control` 7px (buttons, inputs, segments),
  `rounded-panel` 10px (panels, receipts), `rounded-full` only for dots, nodes and rings. Never `rounded-xl`/`rounded-2xl`/`rounded-3xl`.
- Elevation: none. No `shadow-*` classes. Depth comes from the glass surface, the 1px hairline and the 1px inset highlight.
  The only glows are `glow-tone` on a live/current element.
- Mobile (390px): every row stacks; nothing is wider than the viewport; numbers stay right-aligned in their own line; the
  rail keeps its 28px gutter.

### 1.5 Motion

Import from `"motion/react"` (`motion`, `AnimatePresence`, `useReducedMotion`, `animate`). The layout wraps the app in
`<MotionProvider>` (`MotionConfig reducedMotion="user"`); CSS animations are disabled under `prefers-reduced-motion` in globals.css.

| Token                     | Value                              | Use |
|---------------------------|------------------------------------|-----|
| `--ease-glide` / `EASE.glide`   | `cubic-bezier(0.16, 1, 0.3, 1)`  | Everything that arrives: reveals, count-ups, stamps. |
| `--ease-shift` / `EASE.shift`   | `cubic-bezier(0.65, 0, 0.35, 1)` | Things that move between two places: money in transit, segment changes. |
| `--dur-press` / `DUR.press`     | 120ms | Button press. |
| `--dur-quick` / `DUR.quick`     | 200ms | Hover, colour changes. |
| `--dur-reveal` / `DUR.reveal`   | 480ms | Panels and rows entering (y: 8px -> 0, opacity 0 -> 1). |
| `--dur-count` / `DUR.count`     | 900ms | Count-ups. |
| `--dur-transit` / `DUR.transit` | 1400ms | Money moving along the rail. |
| Stagger                         | 50ms per item, max 8 items then all at once | Lists, log lines. |
| Shimmer                         | 2.4s linear, infinite | Verifying only. |
| Pulse                           | 1.8s ease-in-out, infinite | Live dots only (verifying, review countdown). |

JS constants live in `src/components/ui/motion.ts` (`EASE`, `DUR`, `revealProps(i)`).
No springs with overshoot, no `type: "spring"` unless `bounce: 0`. Nothing bounces, wiggles, or scales above 1.02.

### 1.6 Texture

- Grain: applied once by globals.css on `body::after`. Do not add more.
- Gradients: only to mean something. Allowed: the rail connector (state colour to hairline: money has not arrived yet), the
  verifying shimmer, money in transit, the countdown ring track. Nothing else.

---

## 2. Components (`src/components/ui/`)

Import from `@/components/ui` (barrel `index.ts`). "client" means the file is `"use client"`; all others are server-safe.

| Component | File | Use it for | Rules |
|-----------|------|------------|-------|
| `Panel` | `panel.tsx` | Any grouped surface. Props: `as`, `tone` (accent edge), `variant` = `glass` (default) / `solid` / `sunken` / `outline`, `padded`. | The only container with a border. Do not nest glass in glass; nest `sunken` or `outline`. |
| `PageHeader` | `page-header.tsx` | Top of every page: `eyebrow`, `title` (serif), `description`, `actions`, `aside` (stats). | Left-aligned. Never centred. One per page. |
| `Eyebrow` | `page-header.tsx` | Mono uppercase label above a title or a section. | |
| `SectionTitle` | `page-header.tsx` | Serif `type-display-m` heading for a section, optional eyebrow and actions. | |
| `StatePill` | `state-pill.tsx` | A status anywhere. Props: `state` (any contract or milestone status), `size` `sm`/`md`, `label` override. | Never build a pill by hand. Glyph per state; verifying shimmers and pulses. |
| `StateGlyph` | `state-pill.tsx` | The 10px glyph alone (rail nodes, legends). | |
| `Money` | `money.tsx` | Every amount. Props: `minor`, `currency`, `size` `s`/`m`/`l`/`xl`, `animate` (count up on mount), `tone`, `signed`. | Symbol and decimals are muted; integer part is `text-fg` (or tone). |
| `CountUp` | `count-up.tsx` (client) | A non-money number that counts up (`value`, `decimals`, `suffix`). | Money uses `<Money animate>`, not this. |
| `Stat` | `stat.tsx` | Label + big number. Props: `label`, `minor`+`currency` or `value`, `size` `l`/`xl`, `tone`, `hint`. | Count-up is on by default. Lender's book and ledger summary. |
| `Button` | `button.tsx` | All actions. `variant` = `primary` / `secondary` / `ghost` / `danger`, `size` `sm`/`md`, `href` renders a `Link`. | One `primary` per view. Press feedback is built in. Never style a `<button>` by hand. |
| `Rail` / `Station` | `rail.tsx` | The vertical milestone rail. `Station` props: `tone`, `phase` (`done`/`current`/`upcoming`), `title`, `meta`, `aside`, `branch` (side track), `transit`, `children`. | The hero of the contract page. Stations in order; side tracks (`held`, `needs_client`) use `branch`. |
| `MoneyTransit` | `transit.tsx` (client) | Horizontal: the held balance drains on the left while the payee's figure fills on the right. Props: `minor`, `currency`, `from`, `to`, `tone`. | The release moment on the contract page. |
| `Transit` | `transit.tsx` (client) | Money chip that slides down a connector once on mount (`from`/`to` labels, amount). Used by `Station transit={...}`. | Only when money actually moves in that state change (funding, release). |
| `RailCap` | `rail.tsx` | The two ends of a contract rail: `at="start"` (escrow opens, dated by the second signature) and `at="end"` (paid out to the freelancer, amount of total). Props: `tone`, `reached`, `line`, `label`, `detail`. | Always bookend a contract's Rail with both, so side tracks branch off a line and the rail has a destination. |
| `MiniRail` | `rail.tsx` | Inline row of milestone nodes for lists. Props: `items: { state, label }[]`. | Ledger rows, tables. |
| `MoneyBar` | `rail.tsx` | 3px bar, one segment per milestone sized by amount and coloured by state. Props: `items: { state, minor }[]`. | Under a contract total. |
| `Station connect` | `rail.tsx` | Whether a connector runs to the next station. Default true on the main track, false on a branch; `lifecycle()` returns the right value per station. | Always pass `connect={s.connect}` when mapping `lifecycle()`. |
| `lifecycle(status)` | `states.ts` | The station list (main track + side track) for a milestone status. | Use it to render a milestone's own rail. |
| `CountdownRing` | `countdown-ring.tsx` (client) | Review window. Props: `endsAt`, `totalSeconds`, `size` (default 124), `label`. | Teal (`review`) only. `totalSeconds` = `REVIEW_WINDOW_SECONDS` env if set, else the contract's `reviewWindowSeconds`, the same choice as the worker's `reviewWindowSeconds()`. Round any computed SVG coordinate (server and browser floats differ). |
| `LogStream` | `log-stream.tsx` (client) | Verifier logs, PayPal op trail. Props: `lines`, `live`, `stagger`, `maxHeight`. | Always in a sunken well. Lines reveal one by one. |
| `Receipt` / `ReceiptRow` | `receipt.tsx` | Verdicts: perforated paper with dotted-leader rows. | Verdict rows only. One receipt per delivery. |
| `EvidenceChip` | `receipt.tsx` | Tear-off evidence stub: kind + id, optional `href`, `status`. | Attached under the receipt row that cites it. |
| `Stamp` | `receipt.tsx` | The policy decision: rotated, double-ruled, inked in the decision tone, stamps in on mount. `size="sm"` is a one-line stamp for a folded receipt's summary. | One per decision. Text is the action (`Release`, `Hold`, `Partial`, `Ask client`) plus rule ids. |
| `eventTone` / `eventGlyph` / `auditTime` | `src/lib/events.ts` | How an audit event looks anywhere it is listed: tone, glyph, "Oct 08 09:14:53" time. | The contract Activity ledger and the audit grid both use it; never re-map events in a screen. |
| `EmptyState` | `empty-state.tsx` | Nothing to show. Props: `title`, `body`, `action`. | Left-aligned, with the ghost-rail glyph. |
| `Hash` | `hash.tsx` (client) | Any id or hash: middle-truncated, copies on click. Props: `value`, `head`, `tail`, `label`. | Every PayPal id, delivery id, sha. |
| `Kbd` | `hash.tsx` | Keyboard key or literal token. | |
| `Field`, `inputClass` | `field.tsx` | Form label + hint + control; `inputClass` for `<input>`, `<textarea>`, `<select>`. | Sunken well, hairline-strong border, focus ring. |
| `Reveal` | `reveal.tsx` | CSS rise-in for rows and panels (`index` staggers 50ms). Server-safe, so content is never hidden without JS. | Prefer it over motion for static lists. |
| `NavLink` | `nav-link.tsx` (client) | Header links with the active rule. | Layout only. |
| `MotionProvider` | `motion-provider.tsx` (client) | Already in the layout. | |
| `LiveRefresh` / `VerifierLog` | `src/components/live-refresh.tsx` (client) | `LiveRefresh initial={snapshots}`: polls `GET /api/milestones/[id]/status` every 2 s for the page's live milestones and calls `router.refresh()` when one changes. `VerifierLog`: the verifying station's `LogStream`, fed by the same poll. | Live = verifying, review, needs_client, or a capture/payout/refund op still pending. The page renders it only when something is live. Never poll from a screen by hand. |
| `VerdictView folded` | `src/components/verdict-view.tsx` (client) | The receipt as one summary line (result pill, criteria passed, small stamp) with the full receipt behind it. | Review, needs client, held and paid stations. Verifying shows the receipt open. |

### Usage rules

1. A screen is: `PageHeader`, then sections of `Panel`s separated by `mt-12`. Inside panels use hairline dividers
   (`divide-y divide-hairline`), not nested cards.
2. Lists of records are ledgers: one row per record, a mono label header row on desktop (`type-label text-fg-faint`), the
   title in serif, the amount right-aligned in `<Money>`. Rows highlight with `hover:bg-tone-wash` and a 2px tone edge.
3. Amounts count up on first mount only (`animate`), never on every re-render.
4. The colour of a thing comes from its state: wrap it in `data-tone={toneOf(status)}` and use `text-tone` / `border-tone`.
5. Verifying is the only state that animates continuously. Review shows the countdown ring. Released shows money in transit
   once, then rests.
6. Evidence is a receipt: criteria as `ReceiptRow` (criterion, dotted leader, status glyph + confidence in mono),
   `EvidenceChip`s torn off underneath, the policy `Stamp` at the foot.
7. The operator queue is a control room: dense `solid` panels in a grid, mono everywhere, `danger`/`held` tones, `LogStream`
   for the op trail. The lender's book is an instrument panel: a row of `Stat size="xl"` figures, hairline dividers, no charts
   unless they encode money over time.
8. AG Grid tables use the shared `ag-grid-theme.ts`; their surrounding container is a `Panel variant="solid"`.
9. Focus: every interactive element shows `outline: 2px solid var(--focus); outline-offset: 2px` (globals.css does this for
   `:focus-visible`). Do not remove it.
10. Copy: sentence case, plain verbs ("Fund milestone", "Release now"), no exclamation marks.

---

### Demo data

`pnpm db:seed -- --reset --showcase` puts every state on screen: `mst_1` funded, `mst_2` review (window closes 20 minutes
after seeding, verdict pass, decision P6), `mst_3` released (payout op + ledger), `mst_brand_1` needs_client (partial, P5,
6000 of 9000), `mst_brand_2` held (P2). Showcase PayPal ids are display data only, and uploaded files are not on disk.

## 3. Never do

- Never use `zinc`, `gray`, `slate`, `neutral`, `stone` or any Tailwind palette colour class; use tokens.
- Never use `rounded-xl`, `rounded-2xl`, `rounded-3xl`, or `rounded-full` on anything but dots, nodes and rings.
- Never use `shadow-*`, `drop-shadow-*`, or `ring-*` for decoration. (Focus outline only.)
- Never use gradient text, `bg-clip-text`, or a gradient that does not encode state or movement.
- Never centre hero copy or page titles. Everything is left-aligned on a 1100px column.
- Never use emoji or decorative icons. Glyphs come from `StateGlyph`.
- Never set amounts in a proportional font or without `tabular`; never format money by hand (use `<Money>` / `formatMoney`).
- Never write a status pill by hand or use the legacy `status-badge.tsx`.
- Never use `font-bold` or `font-semibold`; never put a serif on a button, label or number.
- Never use `animate-bounce`, `animate-ping`, springs with overshoot, or scale above 1.02.
- Never animate something continuously unless it is live (verifying, a running countdown).
- Never use purple as decoration. Violet means verifying and nothing else.
- Never add another grain layer, background image, blur blob, or glow behind content.
- Never use `dark:` variants for colour; the tokens already switch. (`dark:` is allowed only for an image swap.)

---

## Agents

`/agents` (mandates and their audit) and `/agents/console` (the client's agent in conversation). Built from the existing
primitives; nothing new in `components/ui/`.

- **Mandate terms** (`src/components/agent-console-mandate.tsx`, server-safe): `MandateCard` (the console's side card),
  `ActionChips`, `CapFigure`, `MandatePill`. A mandate's status reuses `StatePill` with a label override: active in the
  funded tone (`state="active"`: it holds delegated authority), revoked in held, expired in draft. Actions are mono chips
  (`rounded-chip`, hairline-strong, `text-fg-muted`), never tone-coloured: an action is not a state. The cap is `<Money>`
  (`size="l"` on the card, `s` in the ledger); a mandate without approve prints "No approvals" in faint mono.
- **`/agents`**: `PageHeader`, then the create form (glass `Panel`) beside a sunken "An agent's approve counts only when"
  list (the five conditions the review route checks, numbered in mono), then the Mandates ledger (serif agent name, id in
  faint mono, chips, cap right-aligned, expiry and last used in mono with a relative line, status pill and a two-step
  danger "Revoke"), then "What your agents did": audit rows whose actor is `agent:<name> for <user>`, in the same
  time/glyph/tone vocabulary as the activity ledger (`src/lib/events.ts`); refusals read in danger with their reason.
- **Token shown once**: after creating, the form becomes a funded-edged panel with the token in a sunken well (mono,
  `break-all`), "Copy token", one primary "Open the console", and the line that Milestone keeps only its hash. The token
  is also kept in this tab's `sessionStorage` (`milestone.agentToken.<id>`, try/catch) so the console can use it; the
  server never stores it.
- **Console frame** (fits 1440x900 with the header): a 612 px row at `lg`, conversation `Panel` (flexes) beside a 320 px
  mandate `Panel`. The conversation has a mono strip on top (agent for client · provider · model, tool count), a scrolling
  transcript, and the composer at the foot (sunken textarea, the one primary "Send"; "Stop" as ghost while a turn runs).
  Turns are ledger rows: a mono label column ("You" / "Agent", 88 px) and the text; no chat bubbles, nothing centred.
- **Tool chip** (`src/components/agent-console-chip.tsx`): one per MCP call, a sunken `rounded-chip` block in mono 12 px.
  Line one: "Milestone MCP ·" or "PayPal MCP ·" (faint) + tool (fg) + arguments (faint, truncated). Line two: a
  `StateGlyph` check (faint) or cross (danger) and the one-line result; when the result names a milestone status, that
  status's `StatePill` sits at the right. A refused call gets a `border-tone` danger edge and `text-tone-ink`. A call in
  flight shows a pulsing faint dot ("calling…"): the only animation, and only while live. Never violet: the agent at work
  is not the verifier.
- **Notices**: when a reply claims an action no successful tool call in that turn made (or calls a queued release paid),
  a mono line in `--ink-needs` under the reply says so ("Not done: …"). The agent gets one correction turn first.
- **PayPal approval link**: when a tool result carries one (fund_milestone's `approvalUrl`, or rel `approve` links), a
  secondary "Approve in PayPal" button under the turn and at the foot of the mandate card, opening a new tab, with the
  faint line "You approve the payment; the agent cannot." Only https PayPal hosts or this app's own paths are shown.
- **Phones**: the two panels stack (conversation first), starters wrap, the eyebrow drops "Milestone MCP + PayPal MCP".
