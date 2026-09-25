# Experiment: Cache Stampede

## Catalog reference
Problem 1.6 - Cache Stampede ("Thundering Herd")

## Initial architecture
Client -> nginx -> App -> Redis (cache-aside, 5s TTL) -> Postgres (simulated 500ms query)

## How it was broken
`make stampede-break` - reset the cache, then fire 200 concurrent requests
(`k6/03-cache-stampede.js`, shared-iterations executor) at a key with no
stampede protection.

## Observation (broken)
`db-hits` counter: ~200 (nearly every request missed the cache and hit
Postgres independently, since all 200 arrived within the same instant
after expiry).

## Root cause
TTL-based expiry has no coordination between concurrent requests - the
first miss doesn't tell the other 199 in-flight requests "I'm already
fetching this."

## Fix applied
Single-flight locking (Redis `SETNX` as a short-lived lock): the first
request to miss acquires the lock and repopulates the cache; every other
concurrent request waits briefly and then reads the now-populated cache
instead of also querying Postgres.

## Observation (fixed)
`db-hits` counter: 1 (only the lock-winner touched Postgres; every other
request either found the cache already warm or waited ~150ms for the lock
to release and then hit the now-populated cache).

## Trade-off
The 199 "losing" requests each pay an extra ~150ms wait instead of hitting
Postgres directly - worth it here because the simulated DB call (500ms) is
slower than the wait, but wouldn't be a clear win if the DB call were
already fast.
