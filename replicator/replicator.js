// Simulated (not real WAL-based) replication: polls the primary for rows
// changed since the last sync, waits REPLICATION_DELAY_MS, then applies
// them to the replica. This is deliberately simplified to make replication
// lag easy to see and easy to tune - it is NOT how real Postgres streaming
// replication works internally.
const { Pool } = require('pg');

const primary = new Pool({ connectionString: process.env.PRIMARY_URL });
const replica = new Pool({ connectionString: process.env.REPLICA_URL });
const delayMs = parseInt(process.env.REPLICATION_DELAY_MS || '3000', 10);

let lastSync = new Date(0);

async function syncLoop() {
  try {
    const { rows } = await primary.query('SELECT * FROM kv WHERE updated_at > $1 ORDER BY updated_at', [lastSync]);
    if (rows.length > 0) {
      await new Promise((r) => setTimeout(r, delayMs)); // artificial lag
      for (const row of rows) {
        await replica.query(
          'INSERT INTO kv(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=$3',
          [row.key, row.value, row.updated_at]
        );
        if (row.updated_at > lastSync) lastSync = row.updated_at;
      }
      console.log(`replicated ${rows.length} row(s), lag=${delayMs}ms`);
    }
  } catch (e) {
    console.error('replicator error', e.message);
  }
  setTimeout(syncLoop, 1000);
}
syncLoop();
