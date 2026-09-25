const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Redis = require('ioredis');
const CircuitBreaker = require('opossum');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(cors({ exposedHeaders: ['X-Instance-Id'] })); // let the dashboard read which instance served a request
app.use(express.json());
app.use(cookieParser());

const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();
app.use((req, res, next) => {
  res.set('X-Instance-Id', INSTANCE_ID);
  next();
});

// ---------- Real request log, kept in memory, for the live dashboard ----------
const LOG_BUFFER = [];
const MAX_LOGS = 500;
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    LOG_BUFFER.push({
      ts: Date.now(),
      instance: INSTANCE_ID,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
    if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.shift();
  });
  next();
});
app.get('/logs/recent', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  res.json(LOG_BUFFER.filter((l) => l.ts > since));
});

const primaryPool = new Pool({ connectionString: process.env.DATABASE_URL });
const replicaPool = new Pool({ connectionString: process.env.REPLICA_DATABASE_URL });
const flakyPool = new Pool({ connectionString: process.env.FLAKY_DATABASE_URL || process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Scenario 8: canary bug injection - random 500s on this instance only
app.use((req, res, next) => {
  if (process.env.BUG_MODE === 'on' && Math.random() < 0.5) {
    return res.status(500).json({ error: 'boom', served_by: INSTANCE_ID });
  }
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', instance: INSTANCE_ID }));
app.get('/hello', (req, res) => res.json({ served_by: INSTANCE_ID }));

// ---------- Scenario 1: single-server bottleneck (CPU-bound, blocks event loop) ----------
app.get('/cpu-work', (req, res) => {
  const ms = parseInt(req.query.ms || '200', 10);
  const end = Date.now() + ms;
  while (Date.now() < end) {} // intentional busy-wait
  res.json({ served_by: INSTANCE_ID, blocked_ms: ms });
});

// ---------- Scenario 2: DB read contention, optional cache-aside ----------
app.get('/product/:id', async (req, res) => {
  const id = req.params.id;
  const useCache = process.env.CACHE_MODE === 'on';
  if (useCache) {
    const cached = await redis.get(`product:${id}`);
    if (cached) return res.json({ ...JSON.parse(cached), from_cache: true, served_by: INSTANCE_ID });
  }
  const { rows } = await primaryPool.query('SELECT * FROM products WHERE id=$1', [id]);
  if (useCache && rows[0]) await redis.set(`product:${id}`, JSON.stringify(rows[0]), 'EX', 30);
  res.json({ ...rows[0], from_cache: false, served_by: INSTANCE_ID });
});

// ---------- Scenario 3: cache stampede, optional single-flight lock ----------
app.get('/hot-item', async (req, res) => {
  const key = 'hot-item';
  const protectionOn = process.env.STAMPEDE_PROTECTION === 'on';
  let cached = await redis.get(key);
  if (cached) return res.json({ value: cached, from_cache: true });

  if (protectionOn) {
    const gotLock = await redis.set(key + ':lock', '1', 'NX', 'EX', 5);
    if (!gotLock) {
      await new Promise((r) => setTimeout(r, 150));
      cached = await redis.get(key);
      if (cached) return res.json({ value: cached, from_cache: true, waited: true });
    }
  }
  await redis.incr('hot-item:db-hits');
  await new Promise((r) => setTimeout(r, 500)); // simulate an expensive DB call
  const value = 'expensive-value-' + Date.now();
  await redis.set(key, value, 'EX', 5);
  if (protectionOn) await redis.del(key + ':lock');
  res.json({ value, from_cache: false });
});
app.get('/hot-item/db-hits', async (req, res) => {
  res.json({ db_hits: parseInt((await redis.get('hot-item:db-hits')) || '0', 10) });
});
app.post('/hot-item/reset', async (req, res) => {
  await redis.del('hot-item', 'hot-item:db-hits', 'hot-item:lock');
  res.json({ reset: true });
});

// ---------- Scenario 4: N+1 vs batched query ----------
app.get('/orders-with-items', async (req, res) => {
  const count = parseInt(req.query.count || '50', 10);
  const batch = process.env.BATCH_QUERY === 'on';
  const start = Date.now();
  let queryCount = 0;
  const { rows: orders } = await primaryPool.query('SELECT id FROM orders LIMIT $1', [count]);
  queryCount++;
  let items;
  if (batch) {
    const ids = orders.map((o) => o.id);
    const { rows } = await primaryPool.query('SELECT * FROM order_items WHERE order_id = ANY($1)', [ids]);
    queryCount++;
    items = rows;
  } else {
    items = [];
    for (const o of orders) {
      const { rows } = await primaryPool.query('SELECT * FROM order_items WHERE order_id=$1', [o.id]);
      queryCount++;
      items.push(...rows);
    }
  }
  res.json({ orders: orders.length, items: items.length, queryCount, duration_ms: Date.now() - start });
});

// ---------- Scenario 6: circuit breaker around a flaky dependency (via toxiproxy) ----------
async function flakyCall() {
  const { rows } = await flakyPool.query('SELECT 1 as ok');
  return rows;
}
const breaker = new CircuitBreaker(flakyCall, { timeout: 1000, errorThresholdPercentage: 50, resetTimeout: 5000 });
breaker.fallback(() => ({ fallback: true }));

app.get('/checkout', async (req, res) => {
  const protectedMode = process.env.CIRCUIT_BREAKER === 'on';
  const start = Date.now();
  try {
    const result = protectedMode ? await breaker.fire() : await flakyCall();
    res.json({ ok: true, result, protected: protectedMode, duration_ms: Date.now() - start });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, protected: protectedMode, duration_ms: Date.now() - start });
  }
});
app.get('/checkout/breaker-status', (req, res) => {
  res.json({ state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed' });
});

// ---------- Scenario 9: race condition vs atomic update ----------
app.post('/decrement-stock', async (req, res) => {
  const atomic = process.env.WRITE_MODE === 'atomic';
  const sku = req.body.sku || 1;
  if (atomic) {
    const { rows } = await primaryPool.query(
      'UPDATE products SET stock = stock - 1 WHERE id=$1 AND stock > 0 RETURNING stock',
      [sku]
    );
    if (rows.length === 0) return res.status(409).json({ ok: false, reason: 'out_of_stock' });
    return res.json({ ok: true, stock: rows[0].stock });
  }
  const { rows } = await primaryPool.query('SELECT stock FROM products WHERE id=$1', [sku]);
  const current = rows[0].stock;
  if (current <= 0) return res.status(409).json({ ok: false, reason: 'out_of_stock' });
  await new Promise((r) => setTimeout(r, 20)); // widen the race window on purpose
  await primaryPool.query('UPDATE products SET stock=$1 WHERE id=$2', [current - 1, sku]);
  res.json({ ok: true, stock: current - 1 });
});
app.get('/stock/:id', async (req, res) => {
  const { rows } = await primaryPool.query('SELECT stock FROM products WHERE id=$1', [req.params.id]);
  res.json(rows[0]);
});
app.post('/stock/:id/reset', async (req, res) => {
  await primaryPool.query('UPDATE products SET stock=$1 WHERE id=$2', [req.body.stock || 50, req.params.id]);
  res.json({ reset: true });
});

// ---------- Scenario 10: replication lag / read-your-writes ----------
app.post('/write/:key', async (req, res) => {
  await primaryPool.query(
    'INSERT INTO kv(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
    [req.params.key, req.body.value]
  );
  res.cookie('recent_write', '1', { maxAge: 5000 });
  res.json({ ok: true });
});
app.get('/read-replica/:key', async (req, res) => {
  const { rows } = await replicaPool.query('SELECT value, updated_at FROM kv WHERE key=$1', [req.params.key]);
  res.json({ source: 'replica', ...rows[0] });
});
app.get('/read-primary/:key', async (req, res) => {
  const { rows } = await primaryPool.query('SELECT value, updated_at FROM kv WHERE key=$1', [req.params.key]);
  res.json({ source: 'primary', ...rows[0] });
});
app.get('/read-smart/:key', async (req, res) => {
  const smart = process.env.READ_MODE === 'smart';
  const recentWrite = req.cookies.recent_write === '1';
  const pool = smart && recentWrite ? primaryPool : replicaPool;
  const { rows } = await pool.query('SELECT value, updated_at FROM kv WHERE key=$1', [req.params.key]);
  res.json({ source: pool === primaryPool ? 'primary' : 'replica', ...rows[0] });
});

// ---------- Scenario 11: dual-write problem vs outbox pattern ----------
app.post('/orders', async (req, res) => {
  const mode = process.env.DUALWRITE_MODE || 'naive';
  const crashProb = parseFloat(process.env.CRASH_PROBABILITY || '0');
  const item = req.body.item || 'widget';

  if (mode === 'naive') {
    const { rows } = await primaryPool.query('INSERT INTO orders(item) VALUES($1) RETURNING id', [item]);
    if (Math.random() < crashProb) {
      return res.status(500).json({ ok: false, reason: 'crashed_before_notify', order_id: rows[0].id });
    }
    await redis.rpush('notifications', JSON.stringify({ order_id: rows[0].id, item }));
    return res.json({ ok: true, order_id: rows[0].id, mode });
  }

  const client = await primaryPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO orders(item) VALUES($1) RETURNING id', [item]);
    await client.query('INSERT INTO outbox(event_type,payload) VALUES($1,$2)', [
      'order_created',
      JSON.stringify({ order_id: rows[0].id, item }),
    ]);
    await client.query('COMMIT');
    res.json({ ok: true, order_id: rows[0].id, mode });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.get('/consistency-check', async (req, res) => {
  const { rows: orderRows } = await primaryPool.query('SELECT count(*) FROM orders');
  const notifCount = await redis.llen('notifications');
  const { rows: outboxRows } = await primaryPool.query('SELECT count(*) FROM outbox WHERE published=false');
  res.json({
    orders: parseInt(orderRows[0].count, 10),
    notifications_sent: notifCount,
    outbox_pending: parseInt(outboxRows[0].count, 10),
  });
});

// Background outbox publisher - only does meaningful work in outbox mode
setInterval(async () => {
  try {
    const { rows } = await primaryPool.query('SELECT * FROM outbox WHERE published=false LIMIT 20');
    for (const row of rows) {
      await redis.rpush('notifications', row.payload);
      await primaryPool.query('UPDATE outbox SET published=true WHERE id=$1', [row.id]);
    }
  } catch (e) {
    console.error('outbox publisher error', e.message);
  }
}, 1000);

// ---------- Scenario 12: idempotency ----------
app.post('/charge', async (req, res) => {
  const idOn = process.env.IDEMPOTENCY === 'on';
  const key = req.header('Idempotency-Key');
  const amount = req.body.amount || 10;
  if (idOn && key) {
    const existing = await redis.get(`idem:${key}`);
    if (existing) return res.json({ ...JSON.parse(existing), replayed: true });
  }
  await redis.incrby('charges:total', amount);
  const result = { ok: true, charge_id: crypto.randomUUID(), amount };
  if (idOn && key) await redis.set(`idem:${key}`, JSON.stringify(result), 'EX', 3600);
  res.json(result);
});
app.get('/charges/total', async (req, res) => {
  res.json({ total: parseInt((await redis.get('charges:total')) || '0', 10) });
});
app.post('/charges/reset', async (req, res) => {
  await redis.set('charges:total', 0);
  res.json({ reset: true });
});

// =========================================================================
// BATCH 2 - the remaining 14 experiments (all real, no new containers needed)
// =========================================================================

// ---------- 1.3 Database write bottleneck: single table vs 4 "shard" tables ----------
// NOTE: this is a same-instance simplification (one Postgres, one disk) - it
// demonstrates reduced lock/index contention, not the full benefit of real
// physically-separate shards. Said plainly so nobody mistakes this for the
// real thing.
app.post('/write-bench', async (req, res) => {
  const mode = req.query.mode === 'sharded' ? 'sharded' : 'single';
  const n = parseInt((req.body && req.body.n) || '500', 10);
  const start = Date.now();
  const promises = [];
  if (mode === 'single') {
    for (let i = 0; i < n; i++) promises.push(primaryPool.query('INSERT INTO single_table(val) VALUES($1)', [i]));
  } else {
    const tables = ['shard_0', 'shard_1', 'shard_2', 'shard_3'];
    for (let i = 0; i < n; i++) promises.push(primaryPool.query(`INSERT INTO ${tables[i % 4]}(val) VALUES($1)`, [i]));
  }
  await Promise.all(promises);
  res.json({ mode, n, duration_ms: Date.now() - start });
});

// ---------- 1.4 Hotspotting: range partitioning by a skewed key vs hash partitioning ----------
const COUNTRIES = ['AU', 'BR', 'CA', 'DE', 'FR', 'IN', 'JP', 'MX', 'NG', 'US'];
app.get('/partition-demo', (req, res) => {
  const strategy = req.query.strategy === 'hash' ? 'hash' : 'range';
  const n = parseInt(req.query.n || '5000', 10);
  const shards = 4;
  const counts = new Array(shards).fill(0);
  for (let uid = 1; uid <= n; uid++) {
    const country = Math.random() < 0.8 ? 'IN' : COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
    let shard;
    if (strategy === 'range') {
      shard = Math.floor((COUNTRIES.indexOf(country) / COUNTRIES.length) * shards);
    } else {
      shard = crypto.createHash('md5').update(String(uid)).digest()[0] % shards;
    }
    counts[shard]++;
  }
  res.json({ strategy, n, shard_counts: counts });
});

// ---------- 1.5 Celebrity problem: fan-out-on-write vs fan-out-on-read ----------
app.post('/post', async (req, res) => {
  const authorId = req.body.authorId || 'user1';
  const followerCount = parseInt(req.body.followerCount || '10', 10);
  const postId = crypto.randomUUID();
  const start = Date.now();
  if (followerCount < 1000) {
    const pipeline = redis.pipeline();
    for (let i = 0; i < followerCount; i++) pipeline.lpush(`feed:${authorId}:${i}`, postId);
    await pipeline.exec();
    return res.json({ mode: 'fanout-on-write', followerCount, writes_performed: followerCount, duration_ms: Date.now() - start });
  }
  await redis.set(`celebrity-post:${authorId}`, postId);
  res.json({ mode: 'fanout-on-read', followerCount, writes_performed: 1, duration_ms: Date.now() - start });
});

// ---------- 1.7 Connection pool exhaustion: a deliberately tiny pool ----------
const smallPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 3000 });
app.get('/slow-query', async (req, res) => {
  const start = Date.now();
  try {
    await smallPool.query('SELECT pg_sleep(2)');
    res.json({ ok: true, duration_ms: Date.now() - start, pool_total: smallPool.totalCount, pool_waiting: smallPool.waitingCount });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, duration_ms: Date.now() - start });
  }
});

// ---------- 1.10 Data growth: real row inserts, real table size ----------
app.post('/bulk-insert', async (req, res) => {
  const n = parseInt((req.body && req.body.n) || '20000', 10);
  await primaryPool.query(
    `INSERT INTO order_items (order_id, sku, qty) SELECT (random()*499+1)::int, 'bulk-sku-'||g, 1 FROM generate_series(1,$1) g`,
    [n]
  );
  res.json({ inserted: n });
});
app.get('/table-size', async (req, res) => {
  const { rows } = await primaryPool.query(
    `SELECT pg_size_pretty(pg_total_relation_size('order_items')) as pretty, pg_total_relation_size('order_items') as bytes`
  );
  res.json(rows[0]);
});

// ---------- 2.8 Third-party dependency outage: graceful degradation ----------
app.post('/place-order-with-payment', async (req, res) => {
  const item = req.body.item || 'widget';
  const { rows } = await primaryPool.query('INSERT INTO orders(item) VALUES($1) RETURNING id', [item]);
  try {
    await breaker.fire();
    res.json({ ok: true, order_id: rows[0].id, payment: 'captured' });
  } catch (e) {
    await redis.rpush('payment-retry-queue', JSON.stringify({ order_id: rows[0].id }));
    res.json({ ok: true, order_id: rows[0].id, payment: 'deferred', reason: 'payment provider unavailable' });
  }
});
app.get('/payment-retry-queue/length', async (req, res) => {
  res.json({ pending: await redis.llen('payment-retry-queue') });
});

// ---------- 2.10 Resource exhaustion: a real, deliberate memory leak ----------
let LEAK_STORE = [];
app.post('/admin/leak', (req, res) => {
  const n = parseInt((req.body && req.body.n) || '200000', 10);
  for (let i = 0; i < n; i++) LEAK_STORE.push({ i, junk: 'x'.repeat(200) });
  res.json({ leaked_objects: LEAK_STORE.length });
});
app.get('/admin/memory', (req, res) => {
  const mem = process.memoryUsage();
  res.json({ rss_mb: Math.round(mem.rss / 1024 / 1024), heapUsed_mb: Math.round(mem.heapUsed / 1024 / 1024), leaked_objects: LEAK_STORE.length });
});
app.post('/admin/leak/reset', (req, res) => {
  LEAK_STORE = [];
  res.json({ reset: true });
});

// ---------- 3.4 Distributed transaction / Saga with a compensating action ----------
app.post('/saga/purchase', async (req, res) => {
  const failAt = req.body.failAt || 'none';
  const steps = [];
  const client = await primaryPool.connect();
  try {
    const dec = await client.query('UPDATE products SET stock = stock - 1 WHERE id=1 AND stock > 0 RETURNING stock');
    if (dec.rows.length === 0) {
      steps.push('inventory_reserve_failed');
      return res.status(409).json({ ok: false, steps });
    }
    steps.push('inventory_reserved');
    if (failAt === 'payment') {
      await client.query('UPDATE products SET stock = stock + 1 WHERE id=1');
      steps.push('payment_failed', 'compensation_inventory_released');
      return res.json({ ok: false, steps });
    }
    steps.push('payment_captured');
    res.json({ ok: true, steps });
  } finally {
    client.release();
  }
});

// ---------- 3.5 Conflicting multi-leader writes ----------
app.post('/region/:name/write', async (req, res) => {
  const region = req.params.name;
  const value = req.body.value;
  const ts = Date.now();
  await redis.hset('multi-leader-doc', region, JSON.stringify({ value, ts }));
  res.json({ region, value, ts });
});
app.get('/region/resolve', async (req, res) => {
  const all = await redis.hgetall('multi-leader-doc');
  const entries = Object.entries(all).map(([region, v]) => ({ region, ...JSON.parse(v) }));
  const lastWriteWins = entries.slice().sort((a, b) => b.ts - a.ts)[0] || null;
  res.json({ entries, last_write_wins: lastWriteWins, merged_union: entries.map((e) => e.value) });
});
app.post('/region/reset', async (req, res) => {
  await redis.del('multi-leader-doc');
  res.json({ reset: true });
});

// ---------- 3.6 Stale cache: explicit write path with optional invalidation ----------
app.put('/product/:id', async (req, res) => {
  const id = req.params.id;
  const name = req.body.name || 'Updated Widget';
  await primaryPool.query('UPDATE products SET name=$1 WHERE id=$2', [name, id]);
  const invalidate = process.env.INVALIDATE_ON_WRITE === 'on';
  if (invalidate) await redis.del(`product:${id}`);
  res.json({ ok: true, invalidated: invalidate });
});

// ---------- 3.7 Clock skew: wall-clock (with injected skew) vs a logical clock ----------
let lamportClock = 0;
app.get('/clock/now', (req, res) => {
  const skew = parseInt(process.env.CLOCK_SKEW_MS || '0', 10);
  res.json({ instance: INSTANCE_ID, wall_clock_ms: Date.now() + skew, skew_applied_ms: skew });
});
app.post('/clock/logical/tick', (req, res) => {
  lamportClock++;
  res.json({ instance: INSTANCE_ID, lamport: lamportClock });
});

// ---------- 3.9 Distributed lock with a lease TTL and a fencing token ----------
let fencingCounter = 0;
app.post('/lock/acquire', async (req, res) => {
  const holder = req.body.holder || 'worker-' + Math.floor(Math.random() * 1000);
  const ttlSec = parseInt(req.body.ttlSec || '5', 10);
  const got = await redis.set('distlock:job-sync', holder, 'NX', 'EX', ttlSec);
  if (!got) {
    return res.status(409).json({ ok: false, held_by: await redis.get('distlock:job-sync') });
  }
  fencingCounter++;
  await redis.set('distlock:fencing', fencingCounter);
  res.json({ ok: true, holder, fencing_token: fencingCounter, ttlSec });
});
app.post('/lock/release', async (req, res) => {
  await redis.del('distlock:job-sync');
  res.json({ released: true });
});
app.get('/lock/status', async (req, res) => {
  const holder = await redis.get('distlock:job-sync');
  const fencing = await redis.get('distlock:fencing');
  res.json({ held_by: holder || null, fencing_token: fencing ? parseInt(fencing, 10) : null });
});

// ---------- 3.10 Eventual consistency confusing UX: a deliberately slow "durable" like ----------
app.post('/like/:postId', async (req, res) => {
  await new Promise((r) => setTimeout(r, 400)); // simulate real replication/commit delay
  const count = await redis.incr(`likes:${req.params.postId}`);
  res.json({ post_id: req.params.postId, likes: count });
});
app.get('/likes/:postId', async (req, res) => {
  res.json({ post_id: req.params.postId, likes: parseInt((await redis.get(`likes:${req.params.postId}`)) || '0', 10) });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`app ${INSTANCE_ID} listening on ${port}`));
