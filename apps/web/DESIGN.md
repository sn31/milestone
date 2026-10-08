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
| `Stamp` | `receipt.tsx` | The policy decision: rotated, double-ruled, inked in the decision tone, stamps in on mount. | One per decision. Text is the action (`Release`, `Hold`, `Partial`, `Ask client`) plus rule ids. |
| `eventTone` / `eventGlyph` / `auditTime` | `src/lib/events.ts` | How an audit event looks anywhere it is listed: tone, glyph, "Oct 08 09:14:53" time. | The contract Activity ledger and the audit grid both use it; never re-map events in a screen. |
| `EmptyState` | `empty-state.tsx` | Nothing to show. Props: `title`, `body`, `action`. | Left-aligned, with the ghost-rail glyph. |
| `Hash` | `hash.tsx` (client) | Any id or hash: middle-truncated, copies on click. Props: `value`, `head`, `tail`, `label`. | Every PayPal id, delivery id, sha. |
| `Kbd` | `hash.tsx` | Keyboard key or literal token. | |
| `Field`, `inputClass` | `field.tsx` | Form label + hint + control; `inputClass` for `<input>`, `<textarea>`, `<select>`. | Sunken well, hairline-strong border, focus ring. |
| `Reveal` | `reveal.tsx` | CSS rise-in for rows and panels (`index` staggers 50ms). Server-safe, so content is never hidden without JS. | Prefer it over motion for static lists. |
| `NavLink` | `nav-link.tsx` (client) | Header links with the active rule. | Layout only. |
| `MotionProvider` | `motion-provider.tsx` (client) | Already in the layout. | |

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
