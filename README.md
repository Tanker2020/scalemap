# Scalemap

**Design multi-region infrastructure, then watch it break — safely.**

Scalemap is a desktop app (Tauri 2 + React 19 + TypeScript) for authoring and simulating
multi-region infrastructure "worlds." You build an architecture — regions, availability
zones, servers, services, managed dependencies, client traffic — and a from-scratch
discrete simulation engine runs it live in front of you: requests route across the globe,
CPUs saturate, circuit breakers trip, replicas get promoted, and you can kill a region
mid-flight to see whether your design actually survives it.

It is a sandbox for the questions that are expensive to answer in production: *What happens
when this AZ goes down? Is this database actually reachable? Where does my p99 come from?
What does this design cost per hour?*

## The four zoom levels

The whole app is one world viewed at four depths — tap an entity for its command overlay,
press-and-hold to drill in:

1. **Globe** — a WebGL night-earth with health-colored region pins, client-population
   markers, and live great-circle traffic arcs driven by the running simulation.
2. **Region** — cross-AZ traffic flow: who's sending (per-population demand streams), how
   it splits across AZs, replication between them, and per-AZ health/cost at a glance.
3. **Availability zone** — an isometric datacenter floor. Racks are optional
   organizational containers with real capacity (default 8U, configurable 4–42); unracked
   servers live in a free pool as standalone pods (the VPS/cloud mental model); the floor
   grows as your fleet does, and new servers boot in with an LED cascade.
4. **Server** — the circuit board: a physical RJ45 intake with link/activity LEDs, a
   firewall rendered as a shield built from its actual rules, your service chips, and the
   machine's own instruments — a per-core load bank, per-service RAM DIMMs, a spinning
   disk platter, noisy-neighbor steal interference.

Everything animated means something: dash speed and density encode real request rate,
LEDs encode real core load, and each view stays within a deliberate motion budget.

## What the simulation models

The engine (`src/lib/worldEngine/`) is a deterministic fixed-step simulation — no canned
animations:

- Demand generation from client populations (with diurnal patterns) and synthetic baseline
- DNS-TTL-cached region routing with health checks, failover, and latency/geo/weighted/
  priority policies
- Per-host CPU/RAM scheduling, VPS burstable credits and noisy-neighbor effects, NIC
  byte-rate caps
- Per-dependency circuit breakers, a BFS flow solver, replica promotion on primary failure
- A 1 Hz metrics pyramid (instance → server → AZ → region → world), an event stream, and a
  replay buffer you can scrub

Alongside the engine:

- **Compiler** — `compileWorld()` resolves your document into concrete service instances
  and permitted/blocked network paths (firewall rules, port bindings, container network
  isolation), surfacing structural findings before you ever press play.
- **Analysis engine** — 13 deterministic rules across structural / network-security /
  capacity families (SPOFs, exposed databases, undersized fleets…), with clickable
  affected-entity chips that jump you to the problem.
- **AI architecture review** — on-demand, schema-validated review against any
  OpenAI-compatible endpoint you configure (bring your own key; it is stored locally,
  never serialized into world files or logs).
- **Cost model** — per-server hourly pricing, managed-service pricing, and tiered
  cross-AZ / cross-region / internet egress costed off live simulated byte rates.

Worlds persist as versioned `.scalemap` JSON files, autosaved while you work, reopening
exactly where you left off.

## Getting started

Prerequisites: [Node.js](https://nodejs.org) ≥ 20, [Rust](https://rustup.rs), and the
[Tauri 2 platform dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
npm install

# Full desktop app with hot reload (recommended)
npm run tauri dev

# Browser-only dev server on port 1420 (file I/O and AI review fall back to mocks)
npm run dev

# Release build
npm run tauri build
```

Start from the home screen's example worlds — the teaching example ships with deliberate
mistakes for the analysis engine to catch.

## Development

```bash
npx vitest          # frontend test suite
npm run build       # type-check + production bundle
cargo test          # Rust-side tests (from src-tauri/)
```

Architecture notes live in [CLAUDE.md](CLAUDE.md) (systems overview and invariants) and
[docs/module-boundaries.md](docs/module-boundaries.md) (file-by-file boundaries and
history). The short version: one normalized world document, one pure compiler every
consumer reads through, one engine behind one facade driven by one store — and views that
never reach around those seams.
