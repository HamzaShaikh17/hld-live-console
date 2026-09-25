# HLD Lab: Break It, Fix It, Measure It

A local Docker Compose sandbox with 12 hands-on experiments — 4 Scaling, 4 High Availability, 4 Consistency. Every experiment follows the same loop: **break it → hit it with real traffic → observe the failure → flip one fix → re-run → compare numbers.**

## Demo

./assests/hld_live_console_demo.mp4


## Prerequisites

- Docker + Docker Compose
- [k6](https://k6.io/docs/get-started/installation/) installed locally, OR just prefix every `k6 run` command below with `docker run --rm -i --network host grafana/k6 run - <` (pipes the script over stdin, no local install needed)
- `curl` and `jq` (optional, for reading responses)

## Quick start

```bash
cd hld-lab
docker compose up -d --build
sleep 5   # let Postgres finish initializing
curl http://localhost:8080/health
```

Everything is reached through nginx on **http://localhost:8080**. Toggles live in `.env` — edit a value, save, then `docker compose up -d` (compose only recreates containers whose config actually changed).

---

# PART 1 — SCALING (4 experiments)

## 1. Single-server bottleneck

**Concept:** one server has a hard CPU/throughput ceiling; horizontal scaling raises it.

```bash
# Break it: point load straight at ONE instance, bypassing the load balancer
docker compose stop app2 app3 app-v2-canary
k6 run k6/01-bottleneck.js
# Watch p95/p99 climb - one instance, all load.
```

```bash
# Fix it: bring the other instances back so nginx spreads the load
docker compose start app2 app3
k6 run k6/01-bottleneck.js
# Compare p95/p99 against the single-instance run.
```

**What to compare:** k6's summary `http_req_duration` p95/p99, before vs after.

---

## 2. Database read contention

**Concept:** every read hits Postgres directly; a cache absorbs the hot path.

```bash
# Break it (CACHE_MODE=off is the default in .env)
k6 run k6/02-read-contention.js
```

```bash
# Fix it
sed -i 's/CACHE_MODE=off/CACHE_MODE=on/' .env
docker compose up -d
k6 run k6/02-read-contention.js
```

**What to compare:** p95 latency, and `docker stats postgres` CPU% during each run.

---

## 3. Cache stampede

**Concept:** when a hot cache key expires, a burst of concurrent requests can all miss at once and hammer the DB simultaneously.

```bash
# Reset, then break it
curl -X POST http://localhost:8080/hot-item/reset
k6 run k6/03-cache-stampede.js
curl http://localhost:8080/hot-item/db-hits
# STAMPEDE_PROTECTION=off -> expect close to 200 DB hits (every request missed)
```

```bash
# Fix it
curl -X POST http://localhost:8080/hot-item/reset
sed -i 's/STAMPEDE_PROTECTION=off/STAMPEDE_PROTECTION=on/' .env
docker compose up -d
k6 run k6/03-cache-stampede.js
curl http://localhost:8080/hot-item/db-hits
# Expect close to 1 DB hit - only the lock-winner actually queried the DB.
```

**What to compare:** the `db-hits` counter, broken vs fixed. This is the clearest before/after in the whole lab.

---

## 4. N+1 queries

**Concept:** looping and issuing one query per row instead of a single batched query.

```bash
# Break it (BATCH_QUERY=off default)
curl "http://localhost:8080/orders-with-items?count=200"
# Note the "queryCount" and "duration_ms" in the response.
```

```bash
# Fix it
sed -i 's/BATCH_QUERY=off/BATCH_QUERY=on/' .env
docker compose up -d
curl "http://localhost:8080/orders-with-items?count=200"
```

**What to compare:** `queryCount` (201 vs 2) and `duration_ms` directly in the JSON response.

---

# PART 2 — HIGH AVAILABILITY (4 experiments)

## 5. Single point of failure & failover

**Concept:** redundancy + a load balancer's health checks let the system survive one instance dying.

```bash
# Break it: run with ONE instance, kill it mid-test
docker compose stop app2 app3 app-v2-canary
k6 run k6/05-failover.js &
sleep 15 && docker compose stop app1
wait
# Expect a wall of errors for the rest of the run - total outage.
```

```bash
# Fix it: run with redundancy, kill one instance mid-test
docker compose start app1 app2 app3
k6 run k6/05-failover.js &
sleep 15 && docker compose stop app2
wait
docker compose start app2
# Expect only a brief, small error blip while nginx reroutes - not a full outage.
```

**What to compare:** k6's error rate (`http_req_failed`) in each run.

---

## 6. Cascading failure → circuit breaker

**Concept:** a slow dependency can exhaust the caller's own capacity unless it fails fast.

```bash
# Inject 3s of latency into the "flaky" Postgres path via toxiproxy
curl -X POST http://localhost:8474/proxies/flaky_pg/toxics \
  -d '{"type":"latency","attributes":{"latency":3000,"jitter":500}}'

# Break it (CIRCUIT_BREAKER=off default)
k6 run k6/06-circuit-breaker.js
```

```bash
# Fix it
sed -i 's/CIRCUIT_BREAKER=off/CIRCUIT_BREAKER=on/' .env
docker compose up -d
k6 run k6/06-circuit-breaker.js
curl http://localhost:8080/checkout/breaker-status
```

```bash
# Clean up the injected latency afterward
curl -X DELETE http://localhost:8474/proxies/flaky_pg/toxics/latency_downstream 2>/dev/null || true
curl http://localhost:8474/proxies/flaky_pg/toxics   # list remaining, delete by name if needed
```

**What to compare:** total throughput and p95 latency, broken vs fixed. With the breaker open, failed requests should return almost instantly (fallback) instead of hanging for the full 3s.

---

## 7. Slow / incorrect failure detection (health-check tuning)

**Concept:** how aggressively a load balancer marks a node unhealthy changes how long users see errors after a crash.

```bash
# Lenient config (slow to notice a dead node)
cp nginx/nginx-lenient-healthcheck.conf nginx/nginx.conf
docker compose restart nginx
k6 run k6/05-failover.js &
sleep 10 && docker compose kill app2   # hard kill, no graceful shutdown
wait
docker compose start app2
```

```bash
# Strict config (fast to notice)
cp nginx/nginx-strict-healthcheck.conf nginx/nginx.conf
docker compose restart nginx
k6 run k6/05-failover.js &
sleep 10 && docker compose kill app2
wait
docker compose start app2
```

**What to compare:** how many consecutive failed requests appear right after the kill, in each run's k6 log output.

---

## 8. Bad deployment (canary blast radius)

**Concept:** shipping a broken version to 100% of traffic vs. a small canary slice changes how many users are affected.

```bash
# Full-traffic "deploy" - hit ONLY the buggy instance directly, simulating no canary
k6 run --env TARGET=full k6/08-canary.js  # or just curl app-v2-canary:3000 in a loop
```

```bash
# Canary - the buggy instance only gets ~10% of traffic via nginx's weighted upstream
k6 run k6/08-canary.js
```

**What to compare:** the error rate. The canary route (`/canary/hello`) should show roughly 1-in-4 requests failing (weight 1 of 4 total) - a contained blast radius versus 50%+ if the bad version took all traffic directly.

---

# PART 3 — CONSISTENCY (4 experiments)

## 9. Race condition on concurrent writes

**Concept:** read-then-write without atomicity lets concurrent requests oversell.

```bash
# Reset stock, break it (WRITE_MODE=race default)
curl -X POST http://localhost:8080/stock/1/reset -H 'Content-Type: application/json' -d '{"stock":50}'
k6 run k6/09-race-condition.js
curl http://localhost:8080/stock/1
# Expect a final stock that doesn't cleanly reflect "50 requests should have failed"
```

```bash
# Fix it
sed -i 's/WRITE_MODE=race/WRITE_MODE=atomic/' .env
docker compose up -d
curl -X POST http://localhost:8080/stock/1/reset -H 'Content-Type: application/json' -d '{"stock":50}'
k6 run k6/09-race-condition.js
curl http://localhost:8080/stock/1
# Expect exactly 0 - exactly 50 succeeded, 50 got 409 out_of_stock.
```

**What to compare:** final `/stock/1` value, and count of 200s vs 409s in the k6 output.

---

## 10. Replication lag / read-your-writes

**Concept:** async replicas can briefly serve stale data right after a write.

```bash
curl -X POST http://localhost:8080/write/mykey -H 'Content-Type: application/json' -d '{"value":"v1"}'
curl http://localhost:8080/read-replica/mykey     # likely still empty/old - replicator hasn't caught up (3s simulated lag)
sleep 4
curl http://localhost:8080/read-replica/mykey     # now shows v1

# Fix: read-your-writes routing
sed -i 's/READ_MODE=replica/READ_MODE=smart/' .env
docker compose up -d
curl -c cookies.txt -X POST http://localhost:8080/write/mykey2 -H 'Content-Type: application/json' -d '{"value":"v2"}'
curl -b cookies.txt http://localhost:8080/read-smart/mykey2   # immediately correct - routed to primary
```

**What to compare:** try lowering/raising `REPLICATION_DELAY_MS` in `.env` (e.g. 500 vs 5000) and see how the staleness window changes.

---

## 11. The dual-write problem → outbox pattern

**Concept:** writing to a DB and a queue as two separate steps can go inconsistent if a crash happens between them.

```bash
# Break it: 30% simulated crash between DB write and notification
sed -i 's/CRASH_PROBABILITY=0/CRASH_PROBABILITY=0.3/' .env
docker compose up -d
for i in $(seq 1 30); do
  curl -s -X POST http://localhost:8080/orders -H 'Content-Type: application/json' -d '{"item":"widget"}' > /dev/null
done
curl http://localhost:8080/consistency-check
# orders count and notifications_sent should now DIVERGE
```

```bash
# Fix it: outbox pattern (same transaction, reliable async publish)
sed -i 's/DUALWRITE_MODE=naive/DUALWRITE_MODE=outbox/' .env
docker compose up -d
for i in $(seq 1 30); do
  curl -s -X POST http://localhost:8080/orders -H 'Content-Type: application/json' -d '{"item":"widget"}' > /dev/null
done
sleep 2   # let the background outbox publisher catch up
curl http://localhost:8080/consistency-check
# orders and notifications_sent should now MATCH, outbox_pending should be ~0
```

**What to compare:** the gap between `orders` and `notifications_sent` in `/consistency-check`, broken vs fixed.

---

## 12. Idempotency failures on retry

**Concept:** at-least-once delivery means retries happen; without an idempotency key, a retried charge is a duplicate charge.

```bash
# Reset, break it (IDEMPOTENCY=off default)
curl -X POST http://localhost:8080/charges/reset
k6 run k6/12-idempotency.js
curl http://localhost:8080/charges/total
# 20 VUs x 3 retries x $10 = expect ~$600 (each retry charged again)
```

```bash
# Fix it
sed -i 's/IDEMPOTENCY=off/IDEMPOTENCY=on/' .env
docker compose up -d
curl -X POST http://localhost:8080/charges/reset
k6 run k6/12-idempotency.js
curl http://localhost:8080/charges/total
# Expect exactly $200 - 20 VUs x $10, each retry recognized as a replay.
```

**What to compare:** the final `/charges/total` number. This is the starkest, most satisfying before/after in the lab - $600 vs $200 for identical traffic.

---

## Resetting everything between runs

```bash
docker compose down -v      # wipes DB volumes too - full reset
docker compose up -d --build
```

## What's simulated vs real, honestly

- **Replication** (`replicator/`) is a simplified poll-and-delay simulation, not real Postgres WAL streaming - built specifically to make lag easy to see and tune, not to teach real replication internals.
- **Circuit breaker** uses the real `opossum` library - this is genuinely how you'd do it in production Node.js.
- **Health checks** use nginx open-source's passive checks (`max_fails`/`fail_timeout`) - real active health checks (polling `/health` continuously) need nginx Plus or a different LB; this still teaches the aggressive-vs-lenient tradeoff correctly.
- **Toxiproxy** is a real, production-grade chaos tool - the latency/failure injection here is exactly how you'd test resilience against a real flaky dependency.
