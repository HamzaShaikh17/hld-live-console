# HLD Lab - failure injection as buttons.
# Every target either BREAKS something or FIXES something; run the paired
# k6/curl check after each to see the number change. Mirrors README.md.

ENV := .env
K6 := k6 run

.PHONY: up down reset normal \
	bottleneck-break bottleneck-fix \
	read-contention-break read-contention-fix \
	stampede-reset stampede-break stampede-fix \
	nplus1-break nplus1-fix \
	failover-single failover-redundant \
	inject-latency clear-latency breaker-break breaker-fix \
	healthcheck-strict healthcheck-lenient \
	canary-test \
	race-reset race-break race-fix \
	replication-lag-demo read-your-writes-demo \
	dualwrite-break dualwrite-fix \
	idempotency-reset idempotency-break idempotency-fix

up:
	docker compose up -d --build
	@echo "waiting for postgres..." && sleep 5
	curl -s http://localhost:8080/health && echo

down:
	docker compose down -v

## Restore every toggle in .env to its "broken" default and bring all instances back up
reset normal:
	sed -i 's/CACHE_MODE=.*/CACHE_MODE=off/' $(ENV)
	sed -i 's/STAMPEDE_PROTECTION=.*/STAMPEDE_PROTECTION=off/' $(ENV)
	sed -i 's/BATCH_QUERY=.*/BATCH_QUERY=off/' $(ENV)
	sed -i 's/CIRCUIT_BREAKER=.*/CIRCUIT_BREAKER=off/' $(ENV)
	sed -i 's/WRITE_MODE=.*/WRITE_MODE=race/' $(ENV)
	sed -i 's/READ_MODE=.*/READ_MODE=replica/' $(ENV)
	sed -i 's/DUALWRITE_MODE=.*/DUALWRITE_MODE=naive/' $(ENV)
	sed -i 's/CRASH_PROBABILITY=.*/CRASH_PROBABILITY=0/' $(ENV)
	sed -i 's/IDEMPOTENCY=.*/IDEMPOTENCY=off/' $(ENV)
	docker compose start app1 app2 app3
	docker compose up -d

# ---------- 1. Single server bottleneck ----------
bottleneck-break:
	docker compose stop app2 app3 app-v2-canary
	$(K6) k6/01-bottleneck.js

bottleneck-fix:
	docker compose start app2 app3
	$(K6) k6/01-bottleneck.js

# ---------- 2. Read contention ----------
read-contention-break:
	sed -i 's/CACHE_MODE=.*/CACHE_MODE=off/' $(ENV); docker compose up -d
	$(K6) k6/02-read-contention.js

read-contention-fix:
	sed -i 's/CACHE_MODE=.*/CACHE_MODE=on/' $(ENV); docker compose up -d
	$(K6) k6/02-read-contention.js

# ---------- 3. Cache stampede ----------
stampede-reset:
	curl -s -X POST http://localhost:8080/hot-item/reset && echo

stampede-break: stampede-reset
	sed -i 's/STAMPEDE_PROTECTION=.*/STAMPEDE_PROTECTION=off/' $(ENV); docker compose up -d
	$(K6) k6/03-cache-stampede.js
	curl -s http://localhost:8080/hot-item/db-hits && echo

stampede-fix: stampede-reset
	sed -i 's/STAMPEDE_PROTECTION=.*/STAMPEDE_PROTECTION=on/' $(ENV); docker compose up -d
	$(K6) k6/03-cache-stampede.js
	curl -s http://localhost:8080/hot-item/db-hits && echo

# ---------- 4. N+1 queries ----------
nplus1-break:
	sed -i 's/BATCH_QUERY=.*/BATCH_QUERY=off/' $(ENV); docker compose up -d
	curl -s "http://localhost:8080/orders-with-items?count=200" && echo

nplus1-fix:
	sed -i 's/BATCH_QUERY=.*/BATCH_QUERY=on/' $(ENV); docker compose up -d
	curl -s "http://localhost:8080/orders-with-items?count=200" && echo

# ---------- 5. SPOF / failover ----------
failover-single:
	docker compose stop app2 app3 app-v2-canary
	($(K6) k6/05-failover.js &) ; sleep 15 ; docker compose stop app1

failover-redundant:
	docker compose start app1 app2 app3
	($(K6) k6/05-failover.js &) ; sleep 15 ; docker compose stop app2 ; sleep 5 ; docker compose start app2

# ---------- 6. Cascading failure / circuit breaker ----------
inject-latency:
	curl -s -X POST http://localhost:8474/proxies/flaky_pg/toxics \
	  -d '{"type":"latency","name":"latency_downstream","attributes":{"latency":3000,"jitter":500}}' && echo

clear-latency:
	curl -s -X DELETE http://localhost:8474/proxies/flaky_pg/toxics/latency_downstream && echo

breaker-break: inject-latency
	sed -i 's/CIRCUIT_BREAKER=.*/CIRCUIT_BREAKER=off/' $(ENV); docker compose up -d
	$(K6) k6/06-circuit-breaker.js

breaker-fix: inject-latency
	sed -i 's/CIRCUIT_BREAKER=.*/CIRCUIT_BREAKER=on/' $(ENV); docker compose up -d
	$(K6) k6/06-circuit-breaker.js
	curl -s http://localhost:8080/checkout/breaker-status && echo

# ---------- 7. Health-check tuning ----------
healthcheck-lenient:
	cp nginx/nginx-lenient-healthcheck.conf nginx/nginx.conf
	docker compose restart nginx
	($(K6) k6/05-failover.js &) ; sleep 10 ; docker compose kill app2 ; sleep 5 ; docker compose start app2

healthcheck-strict:
	cp nginx/nginx-strict-healthcheck.conf nginx/nginx.conf
	docker compose restart nginx
	($(K6) k6/05-failover.js &) ; sleep 10 ; docker compose kill app2 ; sleep 5 ; docker compose start app2

# ---------- 8. Bad deployment / canary ----------
canary-test:
	$(K6) k6/08-canary.js

# ---------- 9. Race condition ----------
race-reset:
	curl -s -X POST http://localhost:8080/stock/1/reset -H 'Content-Type: application/json' -d '{"stock":50}' && echo

race-break: race-reset
	sed -i 's/WRITE_MODE=.*/WRITE_MODE=race/' $(ENV); docker compose up -d
	$(K6) k6/09-race-condition.js
	curl -s http://localhost:8080/stock/1 && echo

race-fix: race-reset
	sed -i 's/WRITE_MODE=.*/WRITE_MODE=atomic/' $(ENV); docker compose up -d
	$(K6) k6/09-race-condition.js
	curl -s http://localhost:8080/stock/1 && echo

# ---------- 10. Replication lag ----------
replication-lag-demo:
	curl -s -X POST http://localhost:8080/write/mykey -H 'Content-Type: application/json' -d '{"value":"v1"}' && echo
	curl -s http://localhost:8080/read-replica/mykey && echo "  <- likely stale/empty"
	sleep 4
	curl -s http://localhost:8080/read-replica/mykey && echo "  <- now caught up"

read-your-writes-demo:
	sed -i 's/READ_MODE=.*/READ_MODE=smart/' $(ENV); docker compose up -d
	curl -s -c /tmp/hldlab-cookies.txt -X POST http://localhost:8080/write/mykey2 -H 'Content-Type: application/json' -d '{"value":"v2"}' && echo
	curl -s -b /tmp/hldlab-cookies.txt http://localhost:8080/read-smart/mykey2 && echo "  <- correct immediately"

# ---------- 11. Dual-write vs outbox ----------
dualwrite-break:
	sed -i 's/DUALWRITE_MODE=.*/DUALWRITE_MODE=naive/' $(ENV); \
	sed -i 's/CRASH_PROBABILITY=.*/CRASH_PROBABILITY=0.3/' $(ENV); docker compose up -d
	for i in $$(seq 1 30); do curl -s -X POST http://localhost:8080/orders -H 'Content-Type: application/json' -d '{"item":"widget"}' > /dev/null; done
	curl -s http://localhost:8080/consistency-check && echo

dualwrite-fix:
	sed -i 's/DUALWRITE_MODE=.*/DUALWRITE_MODE=outbox/' $(ENV); docker compose up -d
	for i in $$(seq 1 30); do curl -s -X POST http://localhost:8080/orders -H 'Content-Type: application/json' -d '{"item":"widget"}' > /dev/null; done
	sleep 2
	curl -s http://localhost:8080/consistency-check && echo

# ---------- 12. Idempotency ----------
idempotency-reset:
	curl -s -X POST http://localhost:8080/charges/reset && echo

idempotency-break: idempotency-reset
	sed -i 's/IDEMPOTENCY=.*/IDEMPOTENCY=off/' $(ENV); docker compose up -d
	$(K6) k6/12-idempotency.js
	curl -s http://localhost:8080/charges/total && echo

idempotency-fix: idempotency-reset
	sed -i 's/IDEMPOTENCY=.*/IDEMPOTENCY=on/' $(ENV); docker compose up -d
	$(K6) k6/12-idempotency.js
	curl -s http://localhost:8080/charges/total && echo
