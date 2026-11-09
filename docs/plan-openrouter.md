# lkclean → OpenRouter (Jev): implementation plan

> Goal: add **OpenRouter** as a *second, selectable* API provider for lkclean —
> **TypeSafe direct stays available**. Jev is *natively available on OpenRouter*
> (`typesafe/jev-1.14`), and OpenRouter serves the **same System One API**
> (`POST https://openrouter.ai/api/v1/systemone`) with the same request/response
> shapes that `src/jev.ts` already uses. The addition is mostly **config, not
> code**: a `provider` setting, a two-entry endpoint map, and UI.
>
> Revision note (2026-11-09): scope corrected by the learner — an earlier draft
> replaced TypeSafe entirely; rejected. The provider selector is the design.
>
> The learner writes all code; the assistant provides `TODO(learner)` anchors
> with explanations, answers questions, and reviews diffs on request.

## Working agreement

- One commit per finished step — every step is individually revertable.
- After each step: `npm run typecheck` turns green, then the change is verified
  by loading `dist/` in Chrome (`chrome://extensions` → reload → reload the
  LinkedIn tab).

## Dev loop (the only 4 commands to know; no Makefile)

```bash
npm install          # once
npm run watch        # leave running while coding (auto-rebuilds dist/)
npm run typecheck    # after every edit
npm run zip          # at the end
```

## Sources (verified 2026-11-09)

- Jev on OpenRouter: https://openrouter.ai/typesafe/jev-1.14
- Tutorial (request/response shapes): https://openrouter.ai/docs/guides/community/jev-tutorial
- Decisions/System One API reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
- TypeSafe SDK pointed at OpenRouter (proves the System One path):
  https://openrouter.ai/docs/guides/community/typesafe-sdk

Key facts:

- Two API surfaces, one key, both billed to OpenRouter:
  1. **System One**: `POST https://openrouter.ai/api/v1/systemone` — same path
     shape TypeSafe serves; `askJev()`'s body `{ model, state, questions }`
     works as-is.
  2. **Decisions**: `POST https://openrouter.ai/api/alpha/decisions` — same
     envelope; adds `usage.cost` (USD).
- Retryable statuses on OpenRouter: `429`, `502`, `503`, `524`, `529`
  (`500` deliberately NOT retried).
- Pricing (Jev 1.14): $0.042 / M input tokens, output free.
- Model ids: `typesafe/jev-1.14` (pinned — thresholds are tuned per version),
  `~typesafe/jev-latest` (tracks latest).

## Design: the providers setting

- `Settings.provider: "typesafe" | "openrouter"`, default `"typesafe"`
  (upgrade-safe default: parity with upstream; the fork owner picks
  OpenRouter in the UI on first run).
- **One key field per provider**: `apiKey` (TypeSafe, unchanged — synced
  storage keeps working) + `openrouterApiKey`.
- **One model field**, free text: `jev-latest` (TypeSafe) vs
  `typesafe/jev-1.14` (OR). Accepted v1 rough edge: switching provider does
  NOT auto-correct the model id (badges the service-worker 4xx otherwise).
- Both hosts in `manifest.json` `host_permissions`; endpoint map in `jev.ts`.
- UI language: English-only (learner decision; French interface replaced,
  including code comments and prompt strings).

## Step 0.5 — dev-dependency bump ✅ done

`esbuild` 0.23.1 → ^0.28.1: two advisories, both triaged as unreachable
(dev-server CORS — this build never calls `serve()`; a withdrawn,
wrong-package advisory about the Deno module). Fixed to keep audits clean.

## Step 0 — curl smoke test ✅ done

Response verified live: `model: typesafe/jev-1.14-20261014` (dated snapshot,
as documented), `answers.self_promo = { type: "noul", noul: 0.78 }`,
`usage.input_tokens: 356`, bonus OpenRouter fields `usage.cost`,
`cost_details`, `provider`. Shape matches `askJev()` expectations exactly.

## Step 1 — the provider selector ✅ done

1. `jev.ts`: `ENDPOINTS: Record<Provider, string>` map (compiler-enforced
   completeness), `askJev(apiKey, provider, model, state, questions)`,
   retry `Set([429, 502, 503, 524, 529])`.
2. `types.ts`: `provider` + `openrouterApiKey`, defaults `provider: "typesafe"`,
   existing `apiKey`/`model` untouched.
3. `manifest.json`: both hosts allowlisted.
4. `options.html`: `<select id="provider">` + two per-provider key inputs;
   `options.ts` maps both fields through `render()`/`read()` with an
   `isProvider` type predicate (no blind cast).
5. `background.ts`: key ternary by provider; provider-neutral missing-key
   error; both args threaded into `askJev()`.
6. Bonus caught during review: `content.ts`'s `apiBroken` regex still expected
   a French error string — updated together with the English sweep (string
   content is invisible to tsc: repo-wide grep is the test suite for this).

Verify on both providers incl. back-and-forth switch ✅ (learner).

## Micro-steps

- **1.5a — settings cache ✅ done.** `loadSettings()` cached at module level,
  invalidated in the existing `chrome.storage.onChanged` listener (sync
  propagates cross-device changes too). Verify recipe: change a threshold
  mid-scroll, next post recomputes immediately.
- **1.5b — Provider moves to types.ts ✅ done.** types.ts is a pure
  declaration leaf again; `ENDPOINTS: Record<Provider, string>` in jev.ts
  makes a missing endpoint fail typecheck.
- **1.5c — Question/Answer contracts move to types.ts ✅ done.** Full Jev
  contract family in types.ts ("API contract" section); `jev.ts` is
  transport-only; "everything imports types.ts, nothing imports back" now
  holds repo-wide.

## Step 2 — housekeeping (next up, pending)

- `package.json`: `description`, `keywords` — dual-provider phrasing.
- `README.md`: two-provider install section (key sources for both paths),
  OpenRouter pricing paragraph; decide the fate of `README.fr.md`
  (assistant recommendation: delete it in this commit — stale docs rot).
- Sweep user-visible strings for provider accuracy (manifest description
  already updated).
- Final: `npm run zip` → fresh Chrome profile install → one scroll session
  end-to-end on both provider settings.

## Step 3 — stretch goals (optional TS exercises)

1. **Real USD cost on the sticker**: `usage.cost` → optional `CallMeta.costUsd`,
   threaded jev→background→sticker. Optional chaining + narrow typing.
2. **"Test connection" button in Options**: options page → service worker →
   one `askJev` smoke call → inline status. Messaging round-trip practice.
3. **Decisions surface client** (`/api/alpha/decisions`) as a second transport
   behind the same `Question`/`Answer` contract — the repo's other-provider
   path if decision models diversify.
4. **Richer choice probabilities** (`probabilities`, not just `confidence`)
   surfaced in the sticker popup.
5. Per-provider model auto-suggest (closes the Step-1 rough edge).

## Rollback philosophy

Each step is one commit; the provider feature reverts cleanly (pre-Step-1 code
has no notion of providers, one host in the manifest). The only persisted
state is strings/numbers in `chrome.storage.sync` — fresh installs start from
`DEFAULT_SETTINGS`.
