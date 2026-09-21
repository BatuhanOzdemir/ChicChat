# User findings: configuration, cases and simulator

Verification completed across the September 15–22, 2026 sessions.
Baseline: repair commit `927f61a`. These follow-up fixes are local and have not
been deployed. Hosted inspection was read-only; no production records were edited.

## Hosted evidence

The Vercel app still displayed the shared-passcode login and the older UI during
inspection, rather than the named-account login introduced by the repair batch.
Pushing that commit did not establish that this production URL was updated.

- [Return, TR100432](https://chicchat-sepia.vercel.app/console/c39af008-a001-41ca-a66b-65cdefe57d63):
  the transcript repeatedly submits `it doesn't fit`, followed by the bot asking
  for a listed reason. `stop` is treated as another invalid answer. Selecting
  `wrong_size` and then the condition completes the case.
- [Exchange, TR100999](https://chicchat-sepia.vercel.app/console/1c20ab67-4f9c-476e-909a-c1a504e98047):
  the Flow item submission succeeds. The later `too tight` reason is repeatedly
  rejected. A manual reason selection completes the case.
- The hosted case list uses month/day/year and opens the read-only case detail.
  It also contains numeric-only orders, including `123456`; `TR` is not mandatory.
- The deployed Demo Apparel policy accepts `^[A-Z0-9]{4,}$`, without a required prefix.

## Findings and corrections

| Finding | Cause / distinction | Local correction |
| --- | --- | --- |
| Policy/configuration resets while adding categories, subcategories or fields | Each action redirected the editor. Unsaved edits could be lost. Category writes do not overwrite saved policy; database regression tests confirm this. The original hosted reset was not reproduced by mutating production. | Save sections in place, preserve unrelated drafts, display inline errors/saved status, reset only successful creation forms. Remount the editor when switching merchants. |
| “Enum” is unclear | It means a predefined list of allowed answers. A text field allows a written answer instead. | Present “Pick from a list,” “Free text,” “Photo,” and “Item description / reference,” with examples and the 10-choice limit. Preserve stored type identifiers and routing values. |
| Cases versus Console | Cases is the full list with filters/statistics. Console is the work queue with priority, status changes and internal notes. | Explain both pages and link case order numbers and “Work on case” directly to the console. |
| TR-prefixed order numbers | Demo seeds/presets use TR examples. Normalization removes separators and uppercases; it does not prepend TR. Each merchant can configure a validation pattern. | Explain the demo convention and use a neutral order-search placeholder. |
| US date order | Date rendering inherited the server's default locale/time zone. | Use DD/MM/YYYY and 24-hour Istanbul time consistently for shared case/console timestamps and simulator activity. |
| Messy-order and Flow preset loops | UI presets still contained invalid free-text reasons even though earlier integration tests used corrected answers. The runner retried the same answer up to 12 times. | Use the valid `wrong_size` choice; test the actual UI presets; pause on a repeated question, missing answer, or processing failure. Let the user continue manually. |
| Cannot stop a simulation | No cancellation control for automatic playback; typing `stop` is ordinary intake input. | Add “Stop preset” and label the existing reset action “End conversation & reset.” Stop prevents subsequent scripted sends; an in-flight request may finish. Reset clears the simulated session and unattached transcript, preserving completed cases. |
| Aging a session seems ineffective | Aging changed timestamps but required a separate maintenance click. | “Age & check” immediately runs inactivity handling for that simulated conversation and reports counts. Return the abandoned case for inspection when one is created. |
| Nudge hides choice buttons | The chat rendered choices only from its final bot message, which becomes the nudge. | Treat inactivity messages as notifications; retain the pending choices while the session remains active and remove them when it ends. |

## Verification

- 195 unit tests passed, including preset interruption/rejection and nudge-choice regressions.
- Production build and TypeScript validation passed on the final source.
- ESLint passed for the source directory, middleware and Next.js configuration; git diff whitespace checks also passed.
- 153 PostgreSQL integration tests passed earlier in this batch against a disposable
  local `chicchat_test` database. They exercise the actual UI presets, preservation
  of saved policy, immediate nudge, one-nudge behavior and abandoned-case creation.
- Local browser checks confirmed unsaved policy and category-name drafts survive
  category/subcategory/field creation; choice fields save correctly; both reported
  presets complete; aging five minutes immediately produces one nudge.
- No hosted migration, account provisioning, deployment, or real WhatsApp send was performed.

## Rollout

These follow-up fixes add no database migrations or dependencies. Deploying the
full repaired application still requires the five migrations and named-account
setup documented in [DEPLOYMENT.md](DEPLOYMENT.md). Existing historical transcripts
remain unchanged; the fixes prevent the same preset behavior on new runs.
