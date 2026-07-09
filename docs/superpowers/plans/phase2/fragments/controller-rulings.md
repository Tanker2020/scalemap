# Controller rulings on fragment SKELETON CONCERNS (assembly must apply these)

From tasks-01-05 writer:
1. baselineDemands lat/lon: RULING — baseline synthetic populations (`baseline:<regionId>`) bypass DNS resolution entirely; T12's facade routes them directly to their own region (they exist to seed ambient load, not to exercise geo-routing). Assembly: ensure T12's text states this; if absent, add one sentence to T12's facade step-order description.
2. "healthy" = not-down (degraded still serves) in resolveRegion/azSplit/pickInstance: RULING — correct, matches legacy engine semantics. Keep as written.
3. createClock helper vs EngineClock contract type: RULING — fine; facade composes helper + contract state. Assembly: confirm T12 doesn't assume they're the same object.

From tasks-13-18 writer:
1. costModel.ts breaks at T12's store rewrite: RULING — T12 must delete src/lib/costModel.ts + its tests + any old-store importers outside the T17 tree in the SAME commit as the store swap (this is the sanctioned early-deletion contingency). Assembly: verify T12's text names costModel.ts; inject if missing.
2. Contracts "exactly" wording vs scrubIndex/scrubBatch/degraded store fields: RULING — additive extension sanctioned; controller will amend the contracts doc ("exactly" → "at minimum") at assembly time.
3. Degradation hook ownership: RULING — T12 owns rolling-mean step-cost watch + stepMs 100→200 + engine_degraded emission; T18 = store flag + SimControls chip + bench only. Assembly: verify T12's text includes it; inject if missing.
4. bench/enginePerf.bench.test.ts naming: RULING — accepted.
5. MANAGED_TYPES ↔ CLOUD_REGISTRY key mismatch alias table in costModelV2: RULING — accepted; ALSO record as Phase-3 cleanup item (align PlacementPanel MANAGED_TYPES with registry keys).
6. ui.store survivors = themeMode only: RULING — accepted (grep-verified).
7. TTL-lag smoke via DEV-only window.__scalemapDebug hook: RULING — accepted for Phase 2 (population authoring UI arrives with Phase 5's globe).
