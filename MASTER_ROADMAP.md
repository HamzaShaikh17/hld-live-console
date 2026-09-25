# HLD Lab: Master Roadmap
### Combining the 30-problem catalog with the "one evolving system" philosophy

Two documents fed into this: your **30-problem catalog** (what to test) and a **"Local HLD Laboratory"** proposal (how to build it). This reconciles them into one plan, and shows exactly where the lab you already have (12 experiments, running today) sits inside that bigger picture — plus what to add, in what order, to eventually cover all 30.

---

## The one idea worth keeping from each document

**From the catalog:** every problem has a name, a root cause, a specific fix, and a trade-off. That structure is what makes 30 problems learnable instead of overwhelming — you're not memorizing 30 unrelated facts, you're applying the same four-part lens 30 times.

**From the lab proposal:** don't build 30 disconnected toy apps. Build **one system that gets progressively more distributed**, and turn each new piece of infrastructure into the thing that lets you *deliberately* trigger the next problem on the list. A cache isn't just "a cache" — it's the prerequisite for experiencing cache stampede and stale-cache problems on purpose.

**The synthesis:** the catalog is your **curriculum**. The evolving system is your **campus**. You don't need the whole campus built before you take the first class — you build the next building exactly when the next problem on the syllabus requires it.

---

## Where the lab you already have fits

The Docker Compose project already built for you (12 experiments, `docker compose up -d --build`) is not a separate thing from this roadmap — it **is** Phases 1–3 of the evolving-system plan below, already working. Specifically:

| Already built | Catalog problems it covers |
|---|---|
| nginx + 4 stateless app instances | 1.1 (single-server bottleneck), 2.1 (SPOF), 2.3 (failure detection), 2.9 (bad deployment/canary) |
| Redis cache layer | 1.2 (read contention), 1.6 (cache stampede), 3.6 (stale cache, via TTL) |
| Postgres primary + N+1 query endpoint | 1.9 (N+1 queries) |
| Postgres "replica" (simulated lag) | 3.2 (replication lag / read-your-writes) |
| Toxiproxy + opossum circuit breaker | 2.2 (cascading failure) |
| Outbox table + background publisher | 3.3 (dual-write problem) |
| Atomic vs. race-prone stock endpoint | 3.1 (race conditions) |
| Idempotency-key endpoint | 3.8 (idempotency failures) |

**That's 12 of the 30 catalog problems, already runnable.** The Makefile added alongside this roadmap turns each into a single command (`make stampede-break`, `make race-fix`, etc.) — directly adopting the lab proposal's "make failures a button" idea, applied to what you've already built rather than a hypothetical future system.

---

## The remaining 18 problems, mapped onto the proposal's phase plan

The lab proposal's 10-phase progression is the right skeleton for the rest. Below, each phase lists what new infrastructure it adds and which catalog problems become testable *because* that infrastructure now exists.

### Phase 4: Message Queue (Redpanda/Kafka) + Workers
**Adds:** an event bus and independent consumer processes, replacing the in-process outbox publisher with a real broker.

| New problem unlocked | Why this phase enables it |
|---|---|
| 1.5 - The "celebrity problem" (fan-out) | Needs a real queue to demonstrate fan-out-on-write vs. fan-out-on-read at any meaningful scale |
| 1.7 - Connection pool exhaustion | Add a connection pooler (PgBouncer) in front of Postgres once multiple workers *and* multiple app instances are hitting it simultaneously |
| 1.8 - Traffic spike → cascading latency | Now has a queue depth metric to actually watch balloon under Little's Law |
| 2.8 - Third-party dependency outage | Simulate a flaky "payment provider" as a worker calling a toxiproxy-fronted fake endpoint |
| 3.4 - Distributed transactions (Saga) | Needs multiple independent services (order, payment, inventory) with their own compensating actions — the natural next step once workers exist |
| 3.5 - Conflicting multi-leader writes | Requires a second write path to actually conflict with the first — introduce this once a second region/worker can write independently |

### Phase 5: Observability (Prometheus + Grafana + OpenTelemetry + Jaeger)
**Adds:** the instrumentation every later experiment needs to actually *see* what's happening, not just infer it from a k6 summary.

| New problem unlocked | Why this phase enables it |
|---|---|
| 2.10 - Resource exhaustion (leaks) | Needs a memory/connection trend graph over hours, not a single load-test run, to actually see a leak |
| Retroactively strengthens all 12 already-built experiments | Every existing "compare before/after" step becomes a real dashboard instead of a terminal number — this is worth doing even before adding new problems |

### Phase 6: Sharding + a second data dimension
**Adds:** partition the Postgres data (e.g., by `user_id % N`) across multiple Postgres instances behind a simple router in the app layer.

| New problem unlocked | Why this phase enables it |
|---|---|
| 1.3 - Database write bottleneck | Directly demonstrated by comparing single-primary write throughput to sharded write throughput |
| 1.4 - Hotspotting | Deliberately partition by a bad key (e.g., `country`) vs. a good one (`hash(user_id)`) and watch one shard take 80% of load |
| 1.10 - Data growth exceeding storage | Fill one shard's disk deliberately, compare to the sharded system's headroom |

### Phase 7: Failure Injection at the Infrastructure Level
**Adds:** systematic use of toxiproxy (already present) for network-level chaos, plus `docker kill` scripting for full-node death, plus a "poison message" and "retry storm" harness on the Phase 4 queue.

| New problem unlocked | Why this phase enables it |
|---|---|
| 2.6 - Split-brain | Needs Consul/etcd (Phase 8) actually in place first — sequence this after Phase 8, or demonstrate a simplified version with two Postgres "primaries" and no consensus, to show the failure mode before showing the fix |
| Queue: poison message / DLQ | Send an unprocessable message on the Phase-4 queue, watch retries exhaust, confirm it lands in a dead-letter queue |
| Queue: retry storm | Make a downstream dependency return 500s under immediate (no backoff) retry, watch load amplify, then fix with exponential backoff + jitter |
| Queue: consumer lag | Produce faster than workers consume, watch queue depth grow on the new Prometheus dashboard, fix by adding worker replicas |

### Phase 8: Service Discovery (Consul)
**Adds:** real leader election and health-aware service registration, replacing nginx's static upstream list.

| New problem unlocked | Why this phase enables it |
|---|---|
| 2.6 - Split-brain (properly, this time) | Consul's Raft-based consensus is what actually prevents two nodes from both believing they're the leader during a partition — revisit the simplified Phase-7 version and show the real fix |
| 3.9 - Distributed lock failures | Consul provides real session-based distributed locks; deliberately kill a lock holder and watch lease expiry vs. fencing-token behavior |

### Phase 9: Security & Multi-Tenancy
**Adds:** JWT auth at the gateway, an authorization layer, and a second tenant sharing the same infrastructure.

| New problem unlocked | Why this phase enables it |
|---|---|
| Security: authentication/authorization | Needs a real JWT-issuing flow and protected endpoints to test 401/403 behavior concretely |
| Tenant isolation | Needs a second tenant's data actually present to test the "Tenant A must never see Tenant B" boundary |
| Noisy neighbor | Needs two tenants generating real, competing traffic to demonstrate resource starvation and then per-tenant rate limiting |

### Phase 10: Object Storage, Search, Real-Time (MinIO, OpenSearch, WebSockets)
**Adds:** the infrastructure the catalog's diagram-review flagged as genuinely missing blocks, not just relabeled existing ones.

| New problem unlocked | Why this phase enables it |
|---|---|
| Large file processing | MinIO + presigned URLs is the actual mechanism, not just a description |
| Full-text/vector search | OpenSearch is the missing tier identified earlier — this phase is where it stops being theoretical |
| Real-time/WebSocket scaling | A connection-gateway component that genuinely breaks the "stateless application layer" assumption everything before this phase relied on — worth experiencing precisely because it violates a rule you've been depending on |

---

## The complete experiments/ folder, all 30 mapped

Adopting the lab proposal's folder structure, extended to cover the full catalog rather than its original 20:

```text
experiments/
├── 01-single-server-bottleneck/     ✅ built  (catalog 1.1)
├── 02-read-contention/              ✅ built  (catalog 1.2)
├── 03-cache-stampede/               ✅ built  (catalog 1.6)
├── 04-n-plus-one/                   ✅ built  (catalog 1.9)
├── 05-spof-failover/                ✅ built  (catalog 2.1, 2.3)
├── 06-cascading-failure/            ✅ built  (catalog 2.2)
├── 07-healthcheck-tuning/           ✅ built  (catalog 2.3)
├── 08-canary-deployment/            ✅ built  (catalog 2.9)
├── 09-race-condition/               ✅ built  (catalog 3.1)
├── 10-replication-lag/              ✅ built  (catalog 3.2)
├── 11-dual-write-outbox/            ✅ built  (catalog 3.3)
├── 12-idempotency/                  ✅ built  (catalog 3.8)
├── 13-write-bottleneck-sharding/    Phase 6   (catalog 1.3)
├── 14-hotspotting/                  Phase 6   (catalog 1.4)
├── 15-celebrity-fanout/             Phase 4   (catalog 1.5)
├── 16-connection-pool-exhaustion/   Phase 4   (catalog 1.7)
├── 17-traffic-spike-queueing/       Phase 4   (catalog 1.8)
├── 18-data-growth-archival/         Phase 6   (catalog 1.10)
├── 19-slow-failover-rto/            Phase 4/7 (catalog 2.4)
├── 20-untested-dr-drill/            Phase 7   (catalog 2.5)
├── 21-split-brain/                  Phase 8   (catalog 2.6)
├── 22-regional-outage/              Phase 10+ (catalog 2.7)
├── 23-third-party-outage/           Phase 4   (catalog 2.8)
├── 24-resource-leak/                Phase 5   (catalog 2.10)
├── 25-saga-distributed-transaction/ Phase 4   (catalog 3.4)
├── 26-multi-leader-conflicts/       Phase 4   (catalog 3.5)
├── 27-stale-cache-invalidation/     ✅ partially built (catalog 3.6, via existing TTL)
├── 28-clock-skew-ordering/          Phase 5   (catalog 3.7, via OTel trace IDs)
├── 29-distributed-lock-failure/     Phase 8   (catalog 3.9)
├── 30-eventual-consistency-ux/      Phase 4/10 (catalog 3.10, needs a real UI to feel)
```

**18 of 30 have a clear phase; 12 are already running today.**

---

## The workflow loop, unchanged from the proposal, now with your actual stack

```text
RUN SYSTEM  (docker compose up -d --build)
     ↓
INJECT FAILURE  (make <experiment>-break)
     ↓
OBSERVE  (k6 summary today; Grafana dashboard from Phase 5 onward)
     ↓
IDENTIFY ROOT CAUSE  (the catalog entry's "why it happens")
     ↓
APPLY PATTERN  (make <experiment>-fix)
     ↓
MEASURE AGAIN  (same k6 script, same metric)
     ↓
WRITE THE FAILURE REPORT  (failure-reports/<experiment>.md, template included)
```

The `failure-reports/` folder now has a `TEMPLATE.md` and one filled example (`03-cache-stampede.md`, using the real numbers from your own run) — do this for each of the other 11 already-built experiments before moving to Phase 4, since that's genuinely more valuable than rushing ahead to more infrastructure. The proposal's closing point is the right one to end on: after 20-30 of these reports, you have an empirical knowledge base, not a set of notes you half-remember.

---

## Suggested next action

Don't start Phase 4 yet. Run all 12 existing experiments via the new Makefile, write a failure report for each (30-45 minutes total, following the template), and only then decide whether Redpanda/Prometheus/Consul are worth the added complexity for your specific goals — the proposal's own warning about Kubernetes ("don't learn *how to configure the tool* instead of *why the architecture works*") applies just as much to adding five more infrastructure pieces at once.
