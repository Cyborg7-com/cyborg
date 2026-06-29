# Tasks — autonomy-proactive-trigger (S4)

Ordered, loop-resolvable, CLI-first. Each task ends with an **exact** `npx vitest run …` that must
pass before the next starts. All work is in `packages/server/src/server/cyborg/`. No manual testing.
Run from `packages/server/`.

> Depends on **S1** (`invocation-gate.ts` exporting `shouldInvoke`, `TriggerType`, `InvocationRequest`)
> and **S2** (`autonomy_level` on the cybo / channel regime). Tasks 1–5 are pure and independent of
> S1/S2 wiring; task 6 imports S1. If S1's `TriggerType` is not yet merged, task 6 defines a local
> `type TriggerType` matching S1's union and switches to the import on rebase.

---

### Task 1 — Pure scorer + types (Inner-Thoughts intrinsic motivation + silence amplification)

Create `proactive-trigger.ts` (PURE, no I/O, no daemon deps — sibling of `invocation-gate.ts`).
Export `ProactiveSignals`, `ProactiveContext`, `ProactivePersonality`, `ProactiveDecision`, and:
- `intrinsicMotivation(s, ctx)` = `(relevance + novelty + infoGain − redundancy) · 1.02^(t−τ)`.
- Property contracts: monotone ↑ in relevance/novelty/infoGain, ↓ in redundancy; silence
  amplification grows with `secondsSinceLastSpoke` (`1.02^(t−τ)`); `t−τ=0` → amp factor exactly 1.

Write `proactive-trigger.test.ts` with a `describe("scorer")` block: fixed inputs → fixed score,
monotonicity in each signal, and silence amplification (larger `t−τ` ⇒ strictly larger score).

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts -t "scorer"
```

### Task 2 — QRE logit speak-gate (deterministic σ(λ·Δu))

Add `speakProbability(deltaU, personality)` = `1/(1+e^(−λ·Δu))` and `decideProactive({signals, ctx,
personality, roll?})` returning `ProactiveDecision { speak, pSpeak, pVolunteer, score, deltaU }`.
Decision is **deterministic**: default **threshold mode** (`effective ≥ imThreshold`); when `roll`
is supplied, **System-1 stochastic** (`roll < effective`). No internal `Math.random`.

`describe("qre gate")`: fixed `(signals, ctx, λ, imThreshold)` → fixed `speak` boolean (both true and
false cases); `pSpeak` ∈ (0,1) and rises with `λ` and with `Δu`; injected `roll` flips the decision
deterministically at the boundary.

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts -t "qre gate"
```

### Task 3 — Crowd-redundancy anti-spam + volunteer-dilemma N-scaler

Add `utilityDelta(score, ctx)` subtracting a crowd-redundancy term that grows with `ctx.crowdSize`
(anti-spam: more cybos that could say the same thing ⇒ lower `Δu`), and `volunteerScale(ctx)` =
`crowdSize ≤ 1 ? 1 : 1 − (c/b)^{1/(N−1)}`. Fold `pVolunteer` into `decideProactive`'s `effective`.

`describe("crowd")`: holding signals fixed, **raising `crowdSize` lowers `effective` and can flip a
speak→silent** (the anti-spam invariant); `volunteerScale` strictly ↓ in `N` for fixed `c/b ∈ (0,1)`;
`N=1` ⇒ scale 1.

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts -t "crowd"
```

### Task 4 — Personality wiring (knobs sourced from the cybo)

Add `resolveProactivePersonality(cybo)` → `ProactivePersonality`, reading per-cybo knobs (λ chattiness,
imThreshold, system1Prob) with safe clamps and defaults seeded from `behavior_mode`
(`responsive`→low λ / high threshold; `proactive`→higher λ / lower threshold). Pure (takes a
`StoredCybo`-shaped object, no storage call).

`describe("personality")`: `responsive` vs `proactive` seeds yield ordered λ/threshold; explicit knobs
override the seed; out-of-range knobs are clamped to valid ranges.

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts -t "personality"
```

### Task 5 — D4 unification (`deriveSpawnPosture`, then adopt at the system-triggered sites)

Add pure `deriveSpawnPosture(trigger, opts?)` → `{ autonomous, unattended }`:
`autonomous = trigger ∉ {mention, slash}` (no human invoker); `unattended = autonomous && !ephemeral`.
Invariant: **`unattended ⟹ autonomous`** for every `TriggerType`. Refactor `schedule-runner.ts`
(`trigger="cron"`) and `task-dispatch.ts` (`trigger="task", ephemeral:true`) to set their spawn flags
**via this helper** instead of the hand-set `unattended:true`/`autonomous:true` literals (behavior
byte-identical: cron→{autonomous,unattended}, task→{autonomous, !unattended}).

`describe("spawn posture")`: the `unattended ⟹ autonomous` invariant over ALL trigger types; the
existing cron and task call sites resolve to today's exact flags (the D4-unification regression test);
`self` resolves to `{autonomous:true, unattended:true}`.

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts -t "spawn posture"
```

### Task 6 — Integrate behind the S1 gate (`triggerType="self"`)

On the L3 wake path (the watcher/tick entry in `message-router.ts`, level-gated to L3 from S2): for
each eligible cybo, build `ProactiveSignals/ctx`, run `decideProactive`; **only if `speak`**, build an
S1 `InvocationRequest` with `triggerType="self"`, `authorType` of the triggering post, and call
`shouldInvoke`. Spawn ONLY when S1 returns `invoke:true`, using `deriveSpawnPosture("self")`. The
scorer must NEVER spawn directly — every path goes through `shouldInvoke`.

`describe("self trigger")`: a high-motivation decision produces an `InvocationRequest` with
`triggerType="self"` that S1 adjudicates (a fake/real `shouldInvoke`); a `speak:false` decision emits
NO request; the firewall still blocks `self` in a non-swarm regime when S1 says so (proves the trigger
is *gated*, not authoritative).

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts -t "self trigger"
```

### Final gate — full suite

```
npx vitest run src/server/cyborg/proactive-trigger.test.ts
```
