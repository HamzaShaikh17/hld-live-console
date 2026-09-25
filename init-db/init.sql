CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  stock INT NOT NULL
);
INSERT INTO products (name, stock) VALUES ('Widget', 50);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  item TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id),
  sku TEXT,
  qty INT
);

INSERT INTO orders (item) SELECT 'seed-order-' || g FROM generate_series(1, 500) g;
INSERT INTO order_items (order_id, sku, qty)
  SELECT o.id, 'sku-' || i, 1 FROM orders o, generate_series(1, 3) i;

CREATE TABLE outbox (
  id SERIAL PRIMARY KEY,
  event_type TEXT,
  payload JSONB,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- For the write-bottleneck / "sharding" comparison (1.3)
CREATE TABLE single_table (id SERIAL PRIMARY KEY, val INT);
CREATE TABLE shard_0 (id SERIAL PRIMARY KEY, val INT);
CREATE TABLE shard_1 (id SERIAL PRIMARY KEY, val INT);
CREATE TABLE shard_2 (id SERIAL PRIMARY KEY, val INT);
CREATE TABLE shard_3 (id SERIAL PRIMARY KEY, val INT);
