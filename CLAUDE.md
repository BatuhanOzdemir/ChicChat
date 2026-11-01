# CLAUDE.md — Working Agreement & v0.3 Build Plan

`docs/SPEC.md` = WHAT to build (source of truth for product behaviour).
`docs/ENGINEERING-HANDBOOK.md` = lasting engineering standards.
This file = HOW we work + the CURRENT build plan. Conflicts: SPEC wins on
product behaviour; the Handbook wins on engineering standards.

---

## How we work (unchanged, and non-negotiable)

1. Implement exactly ONE numbered step, then STOP.
2. Every step has a verification gate; run it and show the output.
3. Post the step report (template below) and WAIT for my sign-off ("approved" /
   "next") before starting the next step. Fixes happen within the current step.
4. Commit after each approved step (conventional commits).
5. No skipping ahead, no early scaffolding of future steps.
6. Ambiguity → ask me one focused question, don't guess.
6b. The simulator is the standing test bench: from Step 1 onward, every step
   with user-visible behaviour must be demonstrable in the simulator, and each
   step extends the simulator with whatever controls its features need
   (SPEC §7). "Works but can't be shown in the simulator" fails the gate.
7. Definition of Done per step: gate ✓ · lint ✓ · typecheck ✓ · tests ✓ ·
   Handbook standards respected · committed · report posted · sign-off received.

### Step report template
```
## Step N — <title>  ✅ gate passed
- What I built: <1–3 lines>
- Files added/changed: <list>
- Verification: <command> → <result>
- Notes / decisions / assumptions: <flag anything I chose>
Awaiting sign-off for Step N+1.
```

---

## Where we are

- **v0.2** (Steps 0–8) is complete; the step-by-step record is in
  `docs/DEVELOPMENT-LOG.md` §7, and the September 2026 repair batch and its
  follow-up fixes are §§15–16.
- **Dropped for now (November 2026):** the old v0.2 Steps 9–10 — the İkas
  connector and the live item-picker Flow. No commerce integration is in scope;
  Tier 0 is the only tier. Dev log §8 records what resuming them would need.
- **Meta/WhatsApp:** keep the existing integration working, but no new Meta
  work (Flows, templates, new message types) unless we agree it first. All v0.3
  behaviour is built and demonstrated in the simulator.
- The old rule that v0.3 waits for a real-merchant demo is **dropped**.

---

## v0.3 build plan — AI-assisted intake (SPEC §17)

### Step 0 — Docs for v0.3
- **Build:** record the scope decisions above; replace the v0.2 plan in this
  file with the v0.3 plan; update SPEC (scope, AI-assisted intake section,
  failure rows, İkas/Flow marked out of scope).
- **Gate:** CLAUDE.md, SPEC, README and the dev log agree; nothing still
  presents İkas, the live Flow or the merchant-demo rule as current plan.

### Step 1 — Test set & scoring tool
- **Build:** a versioned file of sample customer first messages and free-text
  answers (English and Turkish, synthetic to start; the user adds real Turkish
  examples) with the expected category, subcategory, fields and choice; a script
  that scores any classifier against it (per-category accuracy, field accuracy,
  how often it wrongly claims high confidence).
- **Gate:** the script runs and scores a fake classifier; output is readable;
  adding an example needs no code change.

### Step 2 — AI connection, masking & merchant switch
- **Build:** one classifier interface with a fake for tests and a real provider
  behind it (provider and model chosen in this step — bring a recommendation
  with costs); phone numbers and order numbers replaced with placeholders
  before anything leaves the server (order numbers still extracted locally by
  the existing normalizer); per-merchant on/off setting in the configuration
  screen, **off by default**; timeout, provider errors and invalid responses
  fall back to the menus with one structured log line; API key as an env var.
- **Gate:** tests prove no unmasked phone or order number is ever sent, the
  switch works per merchant, and every failure path falls back to the menus;
  the simulator can force the AI to time out or fail.

### Step 3 — First-message classification with confirmation
- **Build:** on a new conversation's first free-text message (switch on), the
  model proposes category, subcategory and fields with confidence. Confident →
  one Yes/No confirmation; Yes fills the confirmed values through the existing
  `startIntake` initial-fields path and skips those questions; No or low
  confidence → the normal menus. The simulator side panel shows the proposal.
- **Gate:** in the simulator, a first message containing an order number skips
  to the remaining questions after Yes; No shows the menus; with the switch
  off, behaviour is identical to v0.2.

### Step 4 — Free-text answers mapped to choices, with confirmation
- **Build:** when a typed answer to a choice field matches no listed value, the
  model proposes the closest one ("Wrong size?" Yes/No); Yes records it, No
  re-shows the list. The list is still always shown (SPEC §5).
- **Gate:** the "it doesn't fit" and "too tight" conversations from dev log §16
  complete in the simulator without loops.

### Step 5 — Visibility & accuracy
- **Build:** case detail and console mark which values the AI proposed and the
  customer confirmed; analytics show the AI acceptance rate; the scoring script
  runs against the real provider on the full test set.
- **Gate:** marks and acceptance rate visible for simulator cases; accuracy on
  the test set meets the minimum agreed after Step 1.

**→ v0.3 complete after Step 5 sign-off.** Open decisions: provider/model
(Step 2); the confidence level that triggers a suggestion and the accuracy
minimum (after Step 1); fuller KVKK treatment of AI processing (later stage).
