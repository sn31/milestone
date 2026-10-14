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
(`<em>`); page titles are plain (Review 1, item 7). No `font-bold` anywhere; max weight is `font-medium` (500) for sans, serif stays 400.

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

## Review 1

Critic pass over every screen (`/`, `/contracts/new`, `/contracts/ctr_demo`, `/contracts/ctr_brand`, the audit log, `/lender`,
`/ops`, a 404) as client, freelancer and partner, at 1280 and 390, dark and light, on `db:seed -- --reset --showcase`.
The system holds together: tokens are used, nothing is centred, the serif/mono split is right, no drop shadows, no emoji.
What follows is what still keeps it from reading as one designed instrument, ranked by how much it costs the story.

1. **The rail is not yet the hero.** On `ctr_demo` at 1280 the first station starts ~760px down, after the stats, a
   signatures strip and a scope row, and each in-escrow station then runs 900 to 1,400px of panels (review card, full receipt,
   open evidence grid, forms). The 1.5px connector reads as a margin rule, not the line the money travels along.
   *Fix:* fold the signatures into the header line once both have signed, move the scope into the header, a 2px connector,
   and shorten the stations (items 2, 5, 8).
2. **Two rails compete.** Every station also draws a horizontal lifecycle track, including the ones where it says nothing
   (released: all behind; draft: all ahead). Three parallel tracks per page dilute the vertical one.
   *Fix:* show the lifecycle track only on stations whose money is in escrow, where "which step" is the question.
3. **Contrast failures.** Light `--fg-faint` was 3.05:1 on `bg` and 2.79:1 on `sunken`; light review/released/held/partial
   text sat at 3.4 to 3.9:1 on sunken (PASS, UNTIL RELEASE, amounts in tone). Dark `--fg-faint` was 3.6 to 4.1:1 on
   surface/paper/raised. Ids, timestamps and labels are 10 to 11px faint text, exactly where contrast matters most.
   *Fix:* tokens retuned (table in 1.1/1.2 updated); every text token now clears 4.5:1 on every surface it is used on.
4. **The event vocabulary forks between agents.** The contract page's Activity ledger and the audit grid colour the same
   event differently (`policy.decided` violet dot vs teal arc), use different glyphs, time formats ("Oct 8, 09:14:53 UTC" vs
   "Oct 08 09:14:53") and casing ("MILESTONE review" vs "milestone.review"). Violet on policy, verdict and delivery rows
   also breaks "violet means verifying".
   *Fix:* one `eventTone` / `eventGlyph` in `src/lib/events.ts`, used by both; one time format.
5. **Evidence grid:** with two to four rows, AG Grid's auto-height minimum leaves a ~60px empty band; at 1280 the columns
   sum past the station width so Source is clipped behind a horizontal scroll; and it opens by default for three or fewer
   items, adding ~200px to the held station.
6. **Audit log at 390:** the first rows show "Oct 08 0..." and later rows "08:34:53": rows rendered before the narrow
   breakpoint kept the wide formatter.
7. **A template tic.** Five page titles end on an italic, muted word (Describe the *work*, Audit *log*, Lender's *book*,
   Operator *queue*, Off the *rail*). Once is a voice; five times reads generated. Keep it for the 404 only.
8. **Receipts are airy.** A criterion takes ~145px: label row, a separate confidence row, rationale, a chip row. Three
   criteria plus the stamp make an 800px receipt inside a station. Confidence belongs on the line with the status.
9. **Colour words misused.** "Funding open" is in released green though nothing has been paid; the home ledger labels
   escrow "held" in blue, when Held is the amber side-track state.
10. **Deliver form misaligned.** The branch field is taller and 13px lower than the repository field; the submit button
    hangs under one column.
11. **The release moment lands softly.** At rest, MoneyTransit shows bare `0.00` and `100.00` (no symbol, not `<Money>`)
    either side of a hairline: it reads as a progress bar, not money arriving with someone.
12. **The instrument panel and the control room are empty in the showcase.** With no advances and no failed payouts the
    lender's book is all $0.00 and the queue is clear, so the two denser screens are judged on their empty states.
    Needs seed data (packages/core, not web): one repaid and one outstanding advance, and one failed payout.

Also seen, lower: on `ctr_brand` both milestones are side tracks, so the main line is dashed end to end and the first elbow
starts from nothing; the Next dev indicator covers the footer at 390 (dev only).

### Review 1: what changed

1. Rail as hero: on an active contract the signatures fold into one mono line in the header ("signed by both · date"); the
   strip only appears while a signature is missing. The scope moved into the header. The rail now starts ~200px higher
   and is bookended by `RailCap`s (escrow opened by the client, paid out to the freelancer, amount of total), so side
   tracks branch from a line and the release bead runs into a destination. Connectors are 2px.
2. The lifecycle track only draws on stations whose money is in escrow.
3. Tokens retuned for AA: light `--fg-faint` #636670, `--fg-muted` #484d5b, light state inks darkened (table above);
   dark `--fg-faint` #7c8393.
4. `src/lib/events.ts` is the single event map; the Activity ledger now matches the audit grid (glyph, tone, mono
   `namespace.verb`, "Oct 08 09:14:53"). `contract.approved*` reads funded, `contract.*` draft.
5. Evidence grids size to their rows (globals.css override of AG Grid's auto-height minimum), columns fit the station,
   and the grid starts collapsed; receipt chips still open it at the cited row.
6. The audit grid remounts across the 640px breakpoint, so every row uses the same time format.
7. Italic accents removed from page titles; kept on the 404.
8. Receipt rows: confidence is a short meter beside the status (under the label on mobile); a criterion is ~95px.
9. "Funding open" and signatures read in the funded tone; the home ledger says "in escrow", not "held".
10. Deliver form fields top-align.
11. MoneyTransit shows currency symbols, a 2px track with a tone fill, and the payee figure lands at `type-num-l`.
12. Open: needs seed data outside `apps/web`.

Also fixed while walking the flows: after a resubmission, the new delivery's receipt showed the previous delivery's
policy stamp. A receipt now carries the stamp only when `decision.deliveryId` is that delivery. The stamp prints the
decided amount, and optional criteria are marked on the receipt. The ops summary prints a failure reason in sentence
case rather than upper case.

## Review 2

Second pass on `/contracts/ctr_demo`, `/contracts/ctr_brand` (client and freelancer), the contract ledger and `/lender`, at
1280 and 390, dark and light, on the showcase seed. Screenshots in the session scratchpad (`design2/shots`).

### What changed

1. **Live updates.** The contract page no longer needs a reload while money is moving. `LiveRefresh` polls
   `GET /api/milestones/[id]/status` (status, decidedAt, reviewEndsAt, the latest delivery's verifiedAt, result and evidence
   count, the newest audit id, a pending capture/payout/refund op) every 2 s for milestones that are verifying, in review,
   waiting on the client or have an op in flight, and calls `router.refresh()` when the signature changes. It stops when
   nothing is live, pauses on a hidden tab and slows to 10 s after ten quiet minutes. While verifying, `VerifierLog` prints
   the delivery and the checks, then appends audit events and the deterministic stage's evidence summaries (pass/fail in
   tone) one line every 320 ms as they arrive, and holds the page refresh until the new lines have been seen, so the judge
   watches the lines land before the station moves on to review.
2. **Receipts fold.** Review, needs client, held and paid stations show one line: `Receipt · PASS · 3 of 3 criteria passed`
   and a small `RELEASE · P6 · $100.00` stamp (amount dropped on a phone). The full receipt, delivered files and evidence
   open below it. The review card stays open. At 1280 the review station is ~490px (was 1,149), needs client ~500 (was
   1,345), held ~240 (was 866). The needs-client note that repeated the card's recommendation is gone.
3. **Ledger at 1280.** The Dir column is gone (Debit and Credit already say it); Milestone is 240px and flexes, so
   "Signup form and validation" and "Polish, accessibility and docs" print whole. Refs truncate in the middle only when the
   cell is too narrow, keeping the last segment (`…:partner`, `…_repaid`).
4. **Lender concentration.** The stat goes amber on the same rule as the grid's exposure bars: a client above 60% of the
   outstanding principal (it was 50%, and never with a single client).
5. **Connector.** The current station's connector fades over a fixed 96px at the top and 72px at the bottom instead of a
   share of the station, so a tall station keeps a readable line to its foot.
6. Also found: a held milestone flagged for an operator (payout failed) still offered the freelancer "Resubmit for
   verification", which the worker refuses. It now says why it is held ("A payout item failed: Receiver is unregistered")
   in danger tone and offers no resubmission.

### What remains

1. **Verifying is unseen in the showcase.** No seeded milestone is verifying, so the verifier log was checked by unit
   tests and a faked poll, not on screen. The worker stores all evidence at once with the verdict, so lines arrive in one
   burst (played out one by one); a real stream needs the worker to persist evidence per check as it runs.
2. **The funded station for the freelancer** is ~830px at 1280: release conditions, the advance offer and the deliver
   form, all open. Fold the conditions once the form is the next step, or put the advance offer beside the form.
3. **The review card** is the tallest thing in an in-escrow station (~300px): the 124px ring and the two-column choices.
   At 390 the ring alone takes a row; a smaller ring beside the title on phones would save ~140px.
4. The ledger's txn chip still middle-truncates every showcase id (`txn_sh…st_1`) at 124px.


## Review 3 (critique)

Critic pass for v3. Every screen as client, freelancer and partner at 1280 and 390, dark and light, on
`seed -- --reset --showcase` with a simulated dispute opened on `mst_3`; a live m1-pass delivery through the worker with no
model reachable; rapid CDP bursts (35 to 200 ms) of a role switch, a navigation and a delivery; and 30 frames sampled by
beat from the backup video (1440x900, `demo-run/beats.json`). Screenshots: session scratchpad `critic3/shots`, `critic3/burst`,
`critic3/frames`. The direction holds (ink, serif titles, mono numbers, receipts, one colour per state); what follows is
what still stops the three-minute story from landing. Owners: RAIL (contract page stations, review card, receipt, forms,
verifying stream, release moment), CHROME (home, header, loading, count-up/stat primitives, composer, 404, tokens),
SCREENS (disputes, ops, lender, ledger, activity, AG Grid).

### The nine known problems

1. Verifying never on screen: **confirmed, worse than stated.** Live run: `milestone.verifying` 03:35:03.730, verdict
   03:35:05.156, so verifying lasts 1.4 s without a model; the 2 s poll skipped it and the freelancer's page went from
   FUNDED + "this page moves to verifying on its own" straight to NEEDS CLIENT. A client page opened before the delivery
   never updated at all in 45 s (a funded milestone with no delivery on that page is not live, so nothing polls it). The
   video has the same jump (25.0 s delivered, 28.0 s needs client).
2. Freelancer funded station: **confirmed.** 818 px at 1280, 1,140 px at 390.
3. Review card: **confirmed.** Review station 513 px at 1280 for the client (card ~300); at 390 the ring takes a 150 px row,
   the card is ~570 px and the station 886 px.
4. Ledger txn chip: **confirmed, and it collides.** `txn_show_fund_mst_3` and `txn_show_release_mst_3` both print
   `txn_sh…st_3`; refs (`advance:ad… _repaid`, `release:m… :partner`) and accounts (`partner:usr…:receivable`) truncate too.
5. Count-up blanks: **confirmed.** Video 101.5 to 102.7 s: the audit log's EVENTS / PAYPAL CALLS / DECISIONS labels sit
   over empty space for 1.2 s (`countup-pending` hides the server value until hydration, which is slow in dev).
6. Skeleton flash on role switch: **not reproduced.** A 24-frame burst after a role switch shows the page swap in place
   within 170 ms (the server action re-renders without the route's Suspense fallback), and no video frame shows the
   skeleton. Keep a guard (item 19).
7. Disputes and the sandbox button: **reviewed** (items 11, 12, 9). The sandbox button could only be read in code (it needs
   credentials): it is our own white primary labelled "Fund with PayPal", with no PayPal mark.
8. No first-run explanation: **confirmed** (item 3).
9. Release moment: **confirmed**, and it tells the wrong amount when an advance exists (item 2).

### Ranked issues

1. **RAIL, contract page, verifying.** The "agent is checking the work" beat does not exist on screen (problem 1).
   *Fix:* make verifying a staged client sequence keyed on the delivery id, not on the polled status: the moment a delivery
   is accepted, the station turns violet and `VerifierLog` plays one line per criterion (clone, install with
   `--ignore-scripts`, tamper diff, tests, file checks, judgment or "judgment left to the client"), with a minimum dwell of
   ~6 s even when the verdict is already stored, then hands over to the verdict. Poll funded milestones too (5 s) so the
   counterparty's open page sees a delivery arrive. The worker should still persist evidence per check as it runs (worker
   owner) so the model path streams for real; the staged path must look the same.
2. **RAIL, contract page, release moment.** At 1440 the release is a 100 px band that animates for 1.4 s after a frozen
   4 s gap (video 37.3 to 41.5 s, no intermediate state), shows "payout confirmed by PayPal" before anything moves, sends
   the whole $100.00 to "Frankie Freelancer" although the ledger pays $49.60 to the freelancer and $50.40 to the partner
   (`mst_3`; m1 in the video had a $59.14 advance), and replays on every page load of any released milestone (the m1
   transit plays again at 44.2 s when the hold beat opens the page). *Fix:* a dedicated release state on the station:
   "Releasing · waiting for PayPal" with the payout op id while the webhook is pending, then a full-width band with figures
   at `type-num-xl`, two legs when an advance exists (partner repaid first, then the freelancer's share, matching the
   ledger), the PayPal confirmation tick landing last, and the station scrolled into view. Play it once: only when
   `releasedAt` is within ~60 s or not yet seen (sessionStorage); otherwise render at rest.
3. **CHROME, `/`, first run.** A judge lands on "Contracts" with two rows, $0 or $350 figures and no idea what Milestone
   does or what to click; the lower half of the 1440x900 frame is empty, and the contract pill says ACTIVE in funded blue
   while the bakery contract has a milestone waiting on this client. *Fix:* a first-run band above the ledger (left-aligned,
   no hero centring): one sentence of what it is, a three-node mini rail "Fund → Agent verifies → PayPal releases", and one
   primary "Open the demo contract" to `ctr_demo` for the current role; dismissible (localStorage). In each row, replace the
   ACTIVE pill with the most urgent milestone state for this viewer ("1 needs you" in `needs`, "1 held" in `held`), and
   make the mini rail nodes 14 px so they read at 1440.
4. **RAIL, receipt and needs-client card, the no-model path.** Without a model every judgment row reads like a bug: "not
   judged: no model configured", a 0% meter, UNCLEAR overflowing the status column (ends at x=1226 against PASS at 1201);
   the result pill says PARTIAL in partial-release lime for "2 of 3 passed", colliding with the Partial state; the card
   heading is "Your call". *Fix:* treat deterministic-only as a designed mode: a receipt header chip "Checks only · judgment
   goes to the client", judgment rows rendered "For the client" in `needs` with no meter, a fixed-width status column,
   and a neutral result word ("2 of 3 checked") instead of PARTIAL unless money is actually split. With a model the same
   rows show the model's verdict and confidence; seed data keeps both visible.
5. **RAIL, contract page, station density.** Freelancer's funded station 818/1,140 px (problem 2); every draft station also
   shows its full release conditions and its own white primary "Fund $100.00", so the client's page carries two to three
   primaries at once. *Fix:* only the current station expands. Draft and upcoming stations fold to one line ("3 checks · 2
   required ›"). On the freelancer's funded station, fold the conditions into the deliver form's header ("Checks this
   delivery must pass ›") and put the advance offer beside the form at ≥1024 as a compact card (amount, fee, "Get paid now");
   target ≤480 px. One primary per page: the current station's.
6. **RAIL, needs-client card, addressee and injection.** The freelancer sees the client's card: "Your call" and "Required
   criteria did not pass, so only Hold is available". In the injection case the client gets "Your call" with a single
   option, Hold rendered as the white primary, and the injected commit message is never shown. *Fix:* per-role copy (the
   freelancer reads "Waiting for Casey: 1 check failed" with the failing row), a heading that states the outcome when there
   is one choice ("Hold: a required check failed"), Hold in `held`/danger styling, and a quoted, struck-through excerpt of
   the injected text in a sunken well labelled "Ignored: text addressed to the reviewer".
7. **RAIL, receipt, the hold story.** The script's hold beat says the branch edited an existing test so the result is not
   trusted; the m2-partial receipt shows only "The test suite passes · FAIL · npm test exited 1; last lines:" (empty
   trailer) and no tamper row. After the client approves, the released station still stamps "ASK CLIENT P3". *Fix:* a
   tamper row on every code receipt (CLEAN in released green, or "Existing test changed: test/pricing.test.js · results
   not trusted" in danger) placed above the test row; drop "last lines:" when there are none; after a client decision add
   a second line under the stamp ("Approved by Casey · Oct 8 15:13") or swap to a "Client approved" stamp.
8. **CHROME, count-up and Stat.** Problem 5. *Fix:* never hide the server-rendered value. Render the final figure visible;
   on hydration, animate from 0 only if hydration happened within ~300 ms of first paint and the element is in view, else
   leave it. Remove `countup-pending` (and its CSS failsafe). Applies to `CountUp`, `Money animate` and `Stat`.
9. **RAIL, fund form and PayPal button.** The simulated approve is a full navigation that returns to the top of the page
   (video 9.5 s: header and stats, the funded station off-screen), so the funding transit plays where no one is looking.
   In sandbox the button is our generic primary with no PayPal mark, the one place a PayPal judge expects PayPal's own
   button. *Fix:* return to `?approved=…#mst_x` and scroll the station into view before the transit plays; in sandbox
   render the v6 SDK's PayPal-branded button inside our panel (a documented exception to the state-colour rule), keeping
   our "Simulated · no real money moves" chip for the simulated path.
10. **RAIL, review card.** Problem 3. *Fix:* at ≥640 put a 72 px ring left of a single row (title, one-line body, Approve now
    / Veto release on the right); at 390 a 48 px ring inline with the title and the two buttons side by side, explanations
    as `title`/one shared line. Target ≤200 px desktop, ≤280 px phone. The freelancer's card drops the footnote row.
11. **SCREENS, `/disputes`, layout and a forked receipt.** The evidence pack squeezes a 700 px receipt into a 510 px left
    column while the right column holds two lines for the client (470 px of empty panel). The receipt is a second
    implementation: no perforated edges, the stamp bottom-left instead of right, `C1 TEST` codes, a different header
    ("dlv_show_3 · Oct 10, 2026" vs the contract page's "deterministic-only Oct 8, 2026, 15:13:24 UTC"). RESPONSE DUE
    borrows Held's pause glyph and amber, so a disputed but paid milestone reads as held money. *Fix:* reuse `Receipt` /
    `VerdictView folded` exactly as the contract page does (folded by default, opens full width), give the pack summary
    (funded, paid out, criteria, ledger, timeline) the left column and the response the right; use `needs` tone with its
    own label for "response due", not the held glyph.
12. **SCREENS, `/disputes`, the response composer.** The copilot draft is the showpiece but sits in a 330 px textarea that
    cuts mid-sentence, prints amounts as "100.00 USD" in Geist, and its bracketed citations ([T2, L1], [C1, C2, C3], [D1])
    are plain text. At 390 the freelancer scrolls ~800 px of receipt before reaching it. *Fix:* render the draft as a
    read view with citation chips (mono, hairline) that highlight the cited pack row on hover, an "Edit" toggle for the
    textarea, amounts via `formatMoney`; for the freelancer put Response first on phones.
13. **SCREENS, ledger.** Problem 4 plus: at 390 Debit and Credit are off-screen to the right of a horizontally scrolling
    grid, so the phone ledger shows no money; full-page and recorded captures show an empty ~130 px band where the last
    three rows belong (row virtualisation renders only the first viewport). *Fix:* show txn ids by their meaningful tail
    (`fund · mst_3`, `release · mst_3`, `release · mst_3 · partner`) with the full id in the copy chip's title; same for refs
    and accounts (`partner · receivable`). At 390, stack each entry: account and amount on one line, milestone under it.
    For grids under ~200 rows set `suppressRowVirtualisation` (or `domLayout: "autoHeight"`) so every row is in the DOM.
14. **SCREENS, audit log (`/activity`).** The Detail column is raw `key=value` text truncated at ~210 px
    ("action=hold reason=Required cr…"), the one column that tells the story; at 390 AG Grid's default "Page Size: 20 /
    1 to 20 of 26 / Page" footer is clipped at the right edge and reads as a stock template; `delivery.manual`,
    `verdict.stored` and `dispute.drafted` still dot in violet (violet means verifying). *Fix:* a Detail column that
    renders one sentence per event from `events.ts` ("Hold · required check failed: The test suite passes"), the raw JSON
    in the expanded row; replace the pager with a mono "Show 20 more" row; delivery and verdict events in `draft`/neutral,
    dispute events in `needs`/`danger`.
15. **SCREENS, `/ops`.** On the live failure path (video 128 s) the reason reads "Payout PAYMENT.PAYOUTS-ITEM.FAILED for
    the freelancer: Receiver is unregistered" and the contract page repeats "Receiver is unregistered: Receiver is
    unregistered"; the seeded case says "A payout item failed", so the two paths disagree. "Mark resolved" looks disabled
    until a note is typed (2.7:1 in light); the dev control "Arm next payout failure" sits inside a real case card; the
    audit trail prints `usr_client` instead of names and its well clips to six lines at 390. *Fix:* one formatter for
    payout failures ("Payout failed: receiver is not registered with PayPal"), used by both paths; a real disabled state
    with a hint; move "Arm next payout failure" into a dashed "Simulated PayPal" panel at the foot of the page (as
    `/disputes` does); names from `ACTOR_NAMES`; let the well grow at 390.
16. **SCREENS, `/lender`.** In the video the book is opened after the advance was repaid, so the hero instrument reads
    OUTSTANDING $0.00, EXPECTED LOSS $0.00, CONCENTRATION 0% while the voice-over says "the lender sees what is outstanding
    and what it expects to lose". The Advance on column truncates the milestone ("1. Signup form and valid…") and the age
    ("0d…"). *Fix:* when nothing is outstanding, lead with "Repaid this week" and lifetime advanced as the hero pair; widen
    Advance on to flex and drop the index; and in the shoot, visit `/lender` right after "Get paid now" (video note below).
17. **CHROME, tokens, light theme contrast.** Measured on the light theme: state pill text on its 10% tone wash 3.7 to
    4.1:1 at 10 to 11 px (PASS, FAIL, ACTIVE, IN REVIEW, NEEDS CLIENT), stamp rule ids and amounts 2.9:1 at 10.5 px
    (P3, P6, $100.00), "Veto release" 3.9:1; in both themes `Money` decimals at 12.5 px fall to ~2.1:1 (lender book, ops).
    *Fix:* darken light state inks one step for text on `bg-tone-soft` (or add a `--tone-ink` per state for pill text),
    stamps at full opacity for the rule line, and keep `Money` decimals at `--fg-muted` below 14 px.
18. **CHROME, `/contracts/new`, the no-model copy.** "No model key is set, so a three-milestone demo contract is drafted
    from your total" tells a judge the AI is off, and names a key although the default provider is a local model. *Fix:*
    "Drafting from a template: three milestones split from your total. With a model connected, the compiler reads your
    scope." in the same faint mono, and show which provider compiled a contract on its header line when one did.
19. **CHROME, loading.** Problem 6 did not reproduce, but on a cold dev compile a click on a ledger row gives no feedback
    for ~900 ms and then may show the skeleton. *Fix:* fade `loading.tsx` in after a 250 ms delay (CSS `animation-delay`,
    opacity 0 → 1) so fast loads never flash it, and give ledger rows a pressed state on click.

Lower, not ranked: station meta repeats the index ("01 · no due date" beside a node that already says 01; drop "no due
date"); the bakery's `mst_brand_2` audit trail shows a policy hold followed by a payout attempt (seed story, core); the
Next dev indicator covers the footer at 390 (dev only).

### Notes for the video run (not code)

Use a short demo repo path (`/tmp/milestone-demo`, per `docs/video-script.md`): the deliver field and the receipt's REF
currently print the 90-character scratchpad path (`file:///privat…1-pass`). Visit `/lender` straight after "Get paid now"
so the book shows the advance outstanding. Frame each beat on the station, not the page top: the hold beat's best frame
(62 s) shows the receipt without the HELD pill or the station title.

### Review 3: what CHROME changed

1. **First run on `/` (item 3, problem 8).** A "Start here" band (`src/app/_home/first-run.tsx`) above the ledger has
   one sentence on what Milestone is, the fund → agent verifies → PayPal releases story as a three-station rail (nodes
   and 2px connectors in the state colours; verifying is a still ring, not the live pulse), which role is in use and what
   to do as that role, one primary "Open the signup flow contract" (to `ctr_demo`; the partner also gets "Lender's
   book"), and the guardrails in one mono line. The band is 315 px at 1280, so the whole two-row ledger still fits
   in 1280x900. On phones the steps drop their captions. "Hide" stores `milestone.intro` in localStorage (in try/catch).
   A `<head>` script sets `html[data-intro="hidden"]` before first paint, so a dismissed band never flashes. While the
   band shows, the header's "New contract" is secondary and its description is hidden (`.intro-shown` / `.intro-hidden`
   in globals.css). Dismissed, the header gets them back plus a ghost "How it works".
2. **Row status for the viewer (item 3).** An active contract's pill shows its most urgent milestone, worded for the
   role: "1 needs you" (client) / "1 with client", "1 held", "1 verifying", "1 in review", "1 to deliver" (freelancer)
   / "1 funded". The row's hover edge takes that tone. Mini-rail glyphs on the ledger are 14 px in 24 px nodes, set with
   a descendant class from page.tsx, so `MiniRail` itself is unchanged. Rows have a pressed state (`active:bg-tone-soft`
   with the tone edge shown).
3. **Count-up (item 8, problem 5).** `countup-pending` and its CSS failsafe are gone. `CountUp`, `Money animate` and
   `Stat` print the final value on the server and on first paint, and never animate on mount. When the value changes
   while the page is open (a `router.refresh()`), the figure counts from the number on screen to the new one. A layout
   effect resets it before paint, so the new figure never flashes first. Reduced motion, a hidden tab or an off-screen
   figure jump straight to the new value. A 30-frame burst of the audit log at 40 ms shows 24 / 9 / 2 from the first
   frame. This replaces usage rule 3 ("count up on first mount only").
4. **Light contrast (item 17), additive tokens only.** New `--ink-<state>` tokens: in light, each state colour is
   darkened to ≥5.1:1 on its own 10% wash over `--surface-sunken`; in dark they equal `--state-*`. `[data-tone]` now also
   sets `--tone-ink`, and there is a `text-tone-ink` utility. `StatePill` text and the `danger` Button text ("Veto
   release") use them. `Money size="s"` keeps its symbol and decimals at `--fg-muted` (m and up stay faint).
   **For RAIL:** the stamp's rule ids and amount (receipt.tsx) should use `text-tone-ink` at full opacity; I did not
   touch receipt.tsx.
5. **Composer (item 18).** The no-model line now reads "Drafting from a template: three milestones split from your
   total. With a model connected, the compiler reads your scope." A ghost "Use the example" in the title row fills the
   placeholder brief, so the grey example is not mistaken for text that is already there. Not done here: the contract
   header naming the compiling provider is on the contract page (RAIL).
6. **Loading (item 19, problem 6).** Both `loading.tsx` skeletons fade in after 250 ms (`.loading-delayed`). A warm
   ledger-row click shows about 150 ms of empty main area and then the page, with no skeleton. Role switch: the keys are
   now a client child (`role-switch-keys.tsx`) using `useFormStatus`. The chosen key lights in the first frame and the
   page stays painted while the Server Action re-renders it. A 20-frame burst on `ctr_demo` shows no skeleton.

### Review 3: what SCREENS changed

Items 11 to 16 and must-haves (a) to (d), checked on a seeded copy with a simulated dispute on `mst_3` taken from open to won,
at 1280 and 390, dark and light (screenshots: session scratchpad `screens/shots`).

1. **`/disputes` is a case file** (`dispute-card.tsx`). Header: state pill, case and capture ids, the milestone title at
   `type-display-m`, "Casey Client disputed the payment with PayPal: Not as described", the disputed amount at `type-num-l`
   and "response due Oct 20, 2026 · 10 days left". Under it a four-step case rail (opened, pack compiled, you respond /
   freelancer responds, PayPal decides) with times, the current step glowing in the case tone. Waiting on the freelancer
   is `needs` (◇, "Response due"), with PayPal is `review`, won `released`, lost or conceded `danger`; the held glyph and
   amber are gone from disputes, and the page's Open / At stake stats follow.
2. **The pack** (left): four figures (funded, paid out with the partner's share, criteria, what the client did), then
   the receipt exactly as the contract page folds it (`VerdictView folded`, loaded from the delivery, decision and
   criteria), then the timeline open, then ledger, client's actions and files folded. No second receipt implementation.
3. **The response** (right) is a document on paper: paragraphs in Geist, every bracketed citation a mono chip that lights
   the cited pack row on hover and opens and scrolls to it on click (folds and the folded receipt open themselves), every
   "100.00 USD" set as `<Money>`. "Edit" swaps in a textarea that grows with its text; "Restore the draft" and the
   2000-character count stay. The two endings sit side by side, each with what it does in three lines (Submit: PayPal
   receives this text, the payout stands if PayPal finds for you, the client sees what was sent; Accept: ends it now,
   PayPal refunds $100.00 to Casey, your payout is not reversed here). Accept is a real disabled button with the reason
   while the money is in escrow (the old CSS hack is gone). For the client the right column says what happens next and
   what each ending means for their money; once answered, both see the outcome, the text sent (with chips) and the
   timeline. The freelancer's response comes first on phones.
4. **Ledger txn chip**: "03 fund", "06 release", "07 repayment": the transaction's number on this contract and what its
   legs did (`ledger-labels.ts: txnKind`, so random live ids read the same), full id in the title and on copy. Accounts
   print as "partner · receivable", "held · mst_3", "freelancer"; refs as "release · mst_3 · partner". At 390 the grid is
   replaced by stacked transactions (chip, time, milestone, then each leg as dr/cr, account and amount) and a totals
   block, so the money is on a phone screen with no sideways scroll.
5. **AG Grid bodies render whole**: the ledger, audit log, lender book and evidence panel (`detailGridProps`) set
   `suppressRowVirtualisation` and `suppressColumnVirtualisation` with `domLayout="autoHeight"`, so every row is in the DOM
   from the first paint. The "empty band" in full-page captures was also a stale first frame after the capture resizes
   the viewport; a throwaway capture before the real one avoids it (worth copying into the recorder's helper).
6. **Audit log**: the Detail column is now "What happened", one sentence per event from
   `contracts/[id]/activity/sentence.ts` ("Hold · P2: required criteria failed: …", "Payout to the freelancer failed:
   receiver is not registered with PayPal", "Advance repaid: $50.40 to Parker Partner"); the raw object stays in the
   expanded row. The AG Grid pager is replaced by a mono "20 of 26 events · Show 6 more" row; the search looks through
   every event. On phones the sentence sits under the event name. System actors print as PayPal, Policy, Verifier.
   In `src/lib/events.ts` (shared, surgical edit): only `*.verifying` is violet; `delivery.*`, `verdict.*` and `github.*`
   read `draft`, `dispute.opened` and `dispute.drafted` read `needs`.
7. **`/ops`**: one payout-failure formatter, `src/lib/payout-failure.ts` (`payoutFailureLine`, `payoutReason`): the seeded
   flag and the live webhook flag both read "Payout to the freelancer failed: receiver is not registered with PayPal."
   The contract page (RAIL) should use the same function for its held note. "Mark resolved" is enabled until a note is
   needed and then says "Write down what you did first"; it is truly disabled only for a viewer who may not act, with
   the hint. The trail prints names and sentences and its well grows to 640 px. "Arm next payout failure" left the case
   card for a dashed "Simulated PayPal · Fail the next payout" panel at the foot (milestone, payee, PayPal's answer).
8. **`/lender`**: with nothing outstanding the hero leads with "Repaid this week" (or lifetime repaid) at XL and
   "Advanced, lifetime" beside it, and the third readout becomes outstanding $0; checked by booking a temporary repayment
   in my own database. "Advance on" flexes (no index; the client column is "Client"), and on phones the pinned column
   keeps the age and drops the name.

Open: the sandbox PayPal button is RAIL's (fund form). The worker typecheck currently fails in `jobs/verify.ts`
(`onEvidence` under exactOptionalPropertyTypes), which is another builder's work in progress, not these files.

### Review 3: what CHROME changed (second pass)

7. **Row status follows the viewer.** The urgent state on a home ledger row is now picked per role, so what the viewer can
   act on comes first. The client sees needs client, then review, then held. The freelancer sees funded ("1 to deliver"),
   then held, then with client. The platform sees held first. The signup flow row now reads "1 to deliver" for Frankie
   rather than "1 in review", which Frankie cannot act on.
8. **Re-checked on a fresh showcase seed, with no model reachable.** Screens: session scratchpad `chrome4/shots`; bursts:
   `chrome4/*-sheet.png`. At 1280x900 the first-run band is 297 px and both ledger rows end at y=875. A dismissed band stays
   hidden on reload with no flash, and "How it works" brings it back. A role switch on `ctr_demo` (25 frames, 40 ms apart)
   keeps the page painted and shows no skeleton. On the audit log, 24 / 9 / 2 are readable from the first frame, and no
   `countup-pending` node is left. A cold ledger-row click shows the main area empty for about two frames, then the
   skeleton fading in, then the page, which is the intended behaviour for a slow compile.

### Review 3: what SCREENS changed (second pass)

Re-walked every SCREENS page on a fresh seeded copy with a simulated dispute on `mst_3` taken from open to won, at 1280
and 390, dark and light (session scratchpad `screens/v2`). The first pass held up. These things still read wrong and are fixed:

1. **Audit log, "What happened" cut mid-word.** The sentence now wraps to two lines and the row grows to 62 px (78 on a
   phone) only when the sentence needs it (`textLines` in `detail-grid.tsx`; `detailGridProps` takes a row-height function).
   Short events stay at 44 px. Time, event, milestone and actor are vertically centred in a grown row. AG Grid's own cell
   CSS outranks utility classes, so plain-text cells use an inline `cellStyle` or a small renderer. Actor names truncate
   with a tooltip.
2. **Ledger refs.** In the grid, a ref no longer repeats the milestone that its row already names: `release`,
   `release · partner`, and an advance by its id alone, since the txn chip already says "advance" (`refShort` in
   `ledger-labels.ts`, tested). The `advance · … _repaid` and `ad… _open` truncations are gone at 1280.
3. **Dispute amounts in running text.** The consequences under Submit and Accept, the confirm line, the client's "what
   happens next" and the outcome line set the disputed amount as `<Money>` (mono, tabular). They no longer show
   `formatMoney` text in Geist.
4. **Ops, failed payout row.** The reason sits on its own line in danger tone under the "Failed · freelancer" ruled line,
   so the leader is no longer squeezed to four dots. The audit trail well is capped at 960 px, so a 12-event trail prints
   whole on a phone.
5. **Lender's book on a phone.** Beside the pinned advance, the grid leads with Outstanding, then state, principal and
   repaid. Before, the first swipe showed only the client's exposure bar and no money.

Checks: web typecheck, all tests, boundaries, specifiers and eslint on these files pass. `pnpm --filter @milestone/web lint`
fails only in RAIL files (`contracts/[id]/page.tsx`, `fund-button.tsx`, `ui/transit.tsx`, set-state-in-effect). The
worker typecheck still fails in `jobs/verify.ts` (`onEvidence` under exactOptionalPropertyTypes). Neither belongs to SCREENS.

### Review 3: what RAIL changed

Items 1, 2, 4, 5, 6, 7, 9 and 10 and known problems 1, 2, 3 and 9. Checked on my own seeded copy with no model reachable
(Ollama pointed at a dead address), running a real worker against a demo repo built with `scripts/make-demo-repo.sh`:
fund through simulated PayPal, deliver `m1-pass` and `m2-injection`, approve, and watch the release. Captured at 1440x900
(video frames), 1280 and 390, dark and light, plus one pass with reduced motion. Screens and bursts are in the session
scratchpad under `rail/shots` and `rail/v1` to `rail/v9`.

1. **A real verifying stream (item 1, problem 1).** `runDeterministicStage` and `runUploadStage` take an
   `onEvidence(item)` callback. It fires, already scrubbed, as each check finishes: the tamper check, each context item,
   each test/build/file criterion, and each upload check. The verify job appends each item to `deliveries.evidence`
   while the delivery has no verdict (`evidenceProgress` in `jobs/verify.ts`; a retry resets it). The verdict write
   still replaces the column with the final list, so the column means the same thing once a delivery is verified. A
   failed progress write is logged and never fails verification. The e2e suite covers the order and the
   no-write-after-verdict rule. The status snapshot now carries each item's `criterionId` and the verdict's judged
   criteria. Funded and held milestones are watched every 5 s, so a client page opened before the delivery sees the
   delivery arrive. On screen, the verifying station is keyed on the delivery (`VerifyGate`). The log shows one line every
   420 ms (delivery, pickup, tamper, context, install, each check, then "judgment goes to the client" or the model's
   verdict and confidence, then the policy). A checklist beside the log ticks as each line lands. The station stays on
   screen at least 6 s, even when the verdict came faster than the poll. Measured without a model: delivery to needs
   client takes about 9 s on screen, and the lines arrive from the database in three waves rather than one burst.
2. **The release moment (item 2, problem 9).** After an approval, while the payout waits for PayPal's webhook, the station
   shows "In escrow · releasing" with the escrow figure at XL. The legs wait at a pulsing PayPal bead. They are the same
   legs the release job pays: the partner's `advanceRepayment` first, then the freelancer's share. Once the webhook
   confirms, a full-width band plays once. The station scrolls into view, escrow drains, and the partner leg ($40.28)
   crosses, then the freelancer's ($59.72). "Released on this contract" counts up, the rail's segment fills, and "payout
   confirmed by PayPal" lands last. The legs come from the ledger. The band plays only when `releasedAt` is under 60 s
   old and this tab has not played it (sessionStorage). A reload rests at the end state. Reduced motion shows the end
   state at once. The whole moment fits one 1440x900 frame.
3. **Checks-only mode (item 4).** The receipt header has a "Checks only · judgment goes to the client" chip. Judgment
   rows read CLIENT in `needs`, with no meter. The status column is a fixed 8.5ch. The result word is neutral
   ("2 of 2 passed") unless the decision actually splits money. The client's card says "Every check passed. The rest is
   yours to judge" and quotes the criterion no model judged. The freelancer reads "Every check passed. Waiting for Casey
   to judge the rest". This copy appears only when every check that did run passed.
4. **Station density (item 5, problem 2).** The freelancer's funded station is 378 px at 1280 (was 818). The conditions
   fold into the deliver form's header ("Checks this delivery must pass · 3 checks · 2 required ›"), and the advance offer
   sits beside the form as a compact card. Draft stations fold their conditions to one line, and a later draft's Fund is
   a quiet secondary. A first draft's Fund is the page primary only when no milestone waits on a decision.
5. **Needs-client card per role (item 6).** When the only choice is Hold, the heading states the outcome ("Hold: a
   required check failed") and lists the failing check. Hold is a danger button. The freelancer reads "Waiting for
   Casey: a required check failed" with no controls. An injected commit message is quoted and struck through in a
   sunken danger well, "Ignored: text addressed to the reviewer".
6. **Receipt (item 7).** Every code receipt has a tamper row above the criteria: CLEAN in green, or "Existing test
   changed: test/pricing.test.js · results not trusted" in danger. A folded receipt adds a "Tests not trusted" pill. An
   empty "last lines:" trailer is dropped. After a client decision the stamp carries a countersign ("Approved by Casey ·
   Oct 13 21:55"), also shown beside the folded stamp. Stamp rule ids and amounts use `text-tone-ink` at full opacity
   (CHROME's note).
7. **Fund form and PayPal button (item 9).** The simulated approve comes back to the station: the capture scrolls
   `#mst_x` into view before it turns funded, so the funding transit plays on screen. In sandbox mode the slot renders the
   v6 SDK's own `<paypal-button>` ("Pay with PayPal", PayPal's gold) unmodified, as PayPal's guidelines ask. Only its
   container is ours: a solid sunken frame, a fixed 240 px slot (full width on phones) and the line "PayPal sandbox · test
   accounts only". The simulated path keeps the dashed frame and the "Simulated · no real money moves" chip. Checked
   against real sandbox credentials (client token only, nothing clicked).
8. **Review card (item 10, problem 3).** At 640 px and up, a 72 px ring sits left of one row: title, a one-line body,
   and Approve now / Veto release. The card is about 130 px at 1280. On phones a 48 px ring sits inline with the title
   and the two buttons share a row, about 245 px. The freelancer's card has no controls and no footnote.
9. Also: a held milestone flagged for an operator uses SCREENS' `payoutFailureLine` ("Payout to the freelancer failed:
   receiver is not registered with PayPal."). Counts in serif headings print in mono. The quiet Fund row had a `<p>`
   nested in a `<p>` (a hydration error), now fixed. The folded "Release conditions" line no longer wraps at 390.
   `pnpm --filter @milestone/web lint` passes; the set-state-in-effect and ref-in-render errors are gone
   (`usePlayOnce` is a `useSyncExternalStore`). `test/status-snapshots.test.ts` now expects the new snapshot fields.

Open: the contract header cannot name the compiling provider (CHROME item 18) until contracts record it (a schema
change, core). Two stations that both wait on the client each keep a primary, since each is a decision.

## Review 3 (second look)

Second critic and finisher pass after RAIL, CHROME and SCREENS. All checks were run first, and there was no cross-builder
breakage left in typecheck, tests, lint, boundaries or specifiers. One breakage was found in the browser: RAIL had renamed
the deliver form's repository placeholder, and `scripts/demo/beats.mjs` finds that field by its placeholder, so the backup
recorder could no longer deliver. The placeholder is `https://github.com/you/repo.git` again, with a comment tying it to the
recorder. Then every demo beat was run end to end through the real UI at 1440x900 dark, on the plain seed, with a real worker
and no model reachable (Ollama pointed at a dead address). The beats were the first-run home, opening the signup contract,
funding `mst_1` (simulated), "Get paid now", `/lender`, delivering `m1-pass` from the demo repo, the client's approval and the
release, funding `mst_2`, `m2-partial` held, `m2-injection` flagged, the bakery upload with an armed payout failure,
`/contracts/ctr_demo/activity`, `/ops`, and `/disputes` with a simulated dispute. After that, every screen was swept on the
showcase seed (plus a simulated dispute on `mst_3`) at 1280 and 390, dark and light. Frames are in the session scratchpad
under `design-v3-final/` (`beatNN-*` for the video frames, `screen-*` for the sweep).

### The critique, item by item

1. Verifying beat: **fixed.** On screen the station turns violet, and the log prints one line at a time over about 7 s: the delivery,
   the pickup, the tamper check, the context lines, the install, each check and "judgment goes to the client". A checklist
   ticks beside it, and the station moves to needs client about 9 s after the click (`beat06a`, `beat06b`, `beat06c`).
2. Release moment: **fixed.** While PayPal has not confirmed, the station says "Releasing · waiting for PayPal". The partner
   leg crosses first ($59.14), then the freelancer's ($40.86), and these match the ledger rows. The PayPal tick lands last.
   It plays once, and a reload rests at the end state (`beat07b1`, `beat07b2`, `beat07c`). One gap was left: while waiting,
   both payees read $0.00 with no hint of what was coming. Each leg's label now says "due $59.14" until PayPal confirms.
3. First run on `/`: **fixed** (`beat01`). The rows show what the viewer can act on ("1 needs you", "1 in review").
4. Checks-only receipt: **fixed.** It has the chip, CLIENT rows with no meter, and a neutral "2 of 2 passed". Three things
   still read as broken without a model, and all three are fixed now. The policy line said "Could not verify: …" and now
   reads "Left to the client: …". The receipt header printed the model id `deterministic-only` and now reads "no model ·
   checks only". The audit log said "Verdict: partial by deterministic-only" and now says "Verdict from the checks alone:
   required checks passed; the rest goes to the client".
5. Station density: **fixed.** The freelancer's funded station is 378 px at 1280. One thing was still wrong: once `mst_1`
   was funded, `mst_2` took over the page's primary with the large "Fund this milestone" panel, in the same frame as the
   funding. Now a draft gets that panel only when no milestone holds money in escrow. Otherwise later drafts show the
   quiet "Fund when you are ready" row (`beat03b`). After the release, `mst_2` gets the panel back.
6. Needs-client card per role and injection: **fixed** (`beat08c`). It reads "Hold: a required check failed", Hold is the
   danger button, and the struck-through "Ignored: text addressed to the reviewer" well is shown.
7. Hold receipt: **fixed.** It has the tamper row, no empty trailer, and the countersign. One problem remained: the rows
   came in verdict order, so the failing test row sat last, under the file and judgment rows. Rows now follow the
   contract's criterion order, so "Existing test changed" sits directly above "The test suite passes · FAIL" (`beat08b`).
8. Count-up blanks: **fixed.** The audit log figures (27 / 7 / 4) are on screen in the first captured frame (`beat11`).
9. Fund return and scroll: **fixed.** The station stays in frame through the capture, and the connector fills as it turns
   funded. I did not re-check the sandbox PayPal button (RAIL checked it with real sandbox credentials).
10. Review card: **fixed.** It is about 130 px at 1280 and about 245 px at 390 (`screen-demo-client-*`).
11. and 12. Disputes case file and response composer: **fixed** (`beat13a`, `beat13b`, `screen-disputes-*`).
13. Ledger: **fixed.** It has txn chips ("06 release"), short refs, and stacked transactions at 390 (`screen-ledger-*`).
14. Audit log: **fixed.** Two things were still off: the Event column cut off "milestone.needs_cli…" at 1440, and checks-only
    verdicts printed the raw model id. The Event column is now 228 px, and the sentence is item 4's.
15. Ops: **fixed.** The live failure path now reads the same as the seeded one ("Payout to the freelancer failed: receiver
    is not registered with PayPal."), on both the contract page and `/ops` (`beat12a`, `beat12b`, `beat12c`).
16. Lender: **fixed.** Shot straight after "Get paid now", the book shows $58.33 outstanding (`beat05`). After the
    repayment, the hero leads with "Repaid this week $59.14" (`beat10`).
17. Light contrast: fixed by CHROME's `--ink-*` tokens. I did not re-measure it. In the light sweep the pills, stamps and
    the Veto button read clearly.
18. Composer copy: **fixed.** Naming the compiling provider on the contract header is **not done**: contracts do not
    record it yet (a core schema change).
19. Loading: **fixed.** No skeleton showed in any beat.

### What else this pass fixed

- **Recorder breakage** (described above).
- **Upload receipt rows:** they printed only the counting line ("1 file(s) match *.pdf; best style-guide.pdf is pass").
  They now print what was measured, from the evidence's per-file line: "bakery-logo.png · width 1200 px (min 1024)" and
  "style-guide.pdf · format pdf; 2 page(s) (max 12); contains "Typography"" (`beat09c`). The REF chip `upload:2 file(s)`
  now reads "upload 2 files".
- **Upload hint:** it printed raw globs ("*.{svg,png}, *.pdf") and now reads "SVG, PNG or PDF".
- **Activity actors:** the contract page's Activity printed system actors in lower case ("paypal", "policy"), while the
  audit grid printed "PayPal" and "Policy". Both now use `SYSTEM_ACTOR_NAMES` in `src/lib/events.ts`.
- **Advance card time:** it said "funded 2026-10-13 21:44 UTC" and now uses the audit format, "funded Oct 13 21:44 UTC".
- **Verifier log title:** the type label set the delivery id in upper case ("DLV_922D…"). The id now keeps its case.

### Still open

1. **The dispute drafter** (`packages/verify/src/dispute.ts`, outside `apps/web`) writes "decided to ask client $0.00 under
   rule P3" in the draft, and "Policy decided ask_client under P3 for $0.00" plus "Verdict stored: partial" in the
   timeline, whenever the milestone went through needs client without a model. An ask-client decision has no amount; it
   should read "asked the client to decide (rule P3); the client approved the release".
2. **A released station keeps its full release band at rest** (about 215 px). On a contract with three paid milestones
   that adds up. It could fold to one line ("$59.14 to Parker Partner · $40.86 to Frankie · confirmed by PayPal") when the
   release is not fresh.
3. **The stamp on a released milestone that went through needs client** still reads ASK CLIENT P3 in amber, with "Approved
   by Casey" beside it. That is correct as a record, but in a frame it can read as still waiting.
4. **The receipt REF and the dispute draft print the delivered repository path in full.** For the shoot, build the demo
   repo at a short path (`/tmp/milestone-demo`), as the video notes say.
5. **The client's funded station shows the release conditions open** (about 170 px at 1280 and about 400 px at 390). It is
   useful in the fund beat, but tall on a phone.

## Review 3: baseline suite copy

Rule 9 now has the client's suite grade every code delivery, so the receipt and the live log say that instead of the old
tamper wording ("The delivery left the test machinery alone" is gone).

- **Receipt.** The first row is "Graded by the client's tests" (kind `suite`, status RAN in green) with one line: "The
  suite from 84f62b844f09 ran against the delivered code; removed test/password.test.js (added by the delivery)", or
  "nothing to restore or remove". When the suite could not be put in place it reads "Not graded by the client's tests"
  (UNCLEAR) with the reason, and the folded summary keeps its "Tests not trusted" pill.
- **Flags.** Each gaming hit (`evd_gaming_*`), and any other unclear diff item on a test or build criterion except the
  suite item (new-dependency hits will arrive this way), is its own row in the needs tone: kind `flag`, `file:line` in
  mono, what was found, the flagged line as code, then the reason. The test row a flag made unclear no longer repeats the
  flag; it says "npm test exited 0 with the client's baseline suite. Not trusted: the flag above, so the client decides."
  The folded summary shows "1 flag".
- **The freelancer's own tests** (`evd_*_delivered`, the informational pass) are one quiet mono line at the foot of the
  rows: "The freelancer's own tests: 12 passing, not used for payment". It opens the evidence row when the grid is shown.
- **Failing tests by name.** A failed test row adds the client's failing tests from its log: "npm test exited 1 with the
  client's baseline suite · failing: annual billing gives 20% off twelve months".
- **Live log.** `suite   client's tests from 84f62b844f09 · removed test/password.test.js`, `flag    src/pricing.js:12
  reads process.env.CI · the client decides` (settles the test criterion as unclear on the checklist), and `own     the
  freelancer's own tests · passing (exit 0), not used for payment` (the snapshot's 240-character summaries are cut before
  the counts, so the log falls back to the exit code).
- Checked at 1440x900 dark on a scratch server: m1-pass (RAN, removed the added test, own tests 12 passing, ASK CLIENT
  P3 with no model), m2-partial (RAN, nothing to restore, the client's annual billing test failing, HOLD P2), and an
  env-sniff branch for the flag row (ASK CLIENT P3).
