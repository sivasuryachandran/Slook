import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY, status text NOT NULL, request_text text NOT NULL,
  contract_json jsonb NOT NULL, contract_hash text NOT NULL,
  catalog_snapshot_id text NOT NULL, policy_snapshot_id text NOT NULL,
  order_draft jsonb NOT NULL, scenario text NOT NULL, mode text NOT NULL,
  paypal_order_id text, authorization_id text, final_decision text, lease_at timestamptz, shopper_id text, sim_scenario text, proposal_json jsonb, preflight_decision text, revocation_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS runs_order_uq ON runs(paypal_order_id) WHERE paypal_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_mode_idx ON runs(mode, created_at);
CREATE TABLE IF NOT EXISTS agent_traces (
  id serial PRIMARY KEY, run_id text NOT NULL, provider text, model text, prompt_version text,
  input jsonb, raw_output text, proposal jsonb, trace_mode text NOT NULL, error text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS paypal_snapshots (
  id serial PRIMARY KEY, run_id text, kind text NOT NULL, request_id text, http_status int,
  debug_id text, mode text NOT NULL, body jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS assertions (
  id serial PRIMARY KEY, run_id text NOT NULL, assertion_id text NOT NULL, status text NOT NULL,
  blocking boolean NOT NULL, expected text, actual text, source text, explanation text, stage text NOT NULL DEFAULT 'GATE',
  evaluator_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS actions (
  id serial PRIMARY KEY, run_id text NOT NULL, action text NOT NULL, request_id text NOT NULL,
  endpoint text, status text NOT NULL, http_status int, snapshot_id int,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id, action));
CREATE TABLE IF NOT EXISTS decisions (
  run_id text PRIMARY KEY, decision text NOT NULL, reason_codes jsonb NOT NULL, record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id text PRIMARY KEY, event_type text NOT NULL, verified boolean NOT NULL, verification text,
  run_id text, reference text, raw jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS intent_keys (key_id text PRIMARY KEY, public_pem text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ledger_events (
  id serial PRIMARY KEY, run_id text NOT NULL, kind text NOT NULL, detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), prev_hash text, hash text);
`;

export async function openDb(url) {
  let db;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
    db = { query: (s, p) => pool.query(s, p), kind: 'postgres', close: () => pool.end() };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite(process.env.PGLITE_DIR || undefined); // in-memory unless PGLITE_DIR set
    db = { query: (s, p) => lite.query(s, p), kind: 'pglite', close: () => lite.close() };
  }
  await db.query('SELECT 1');
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  await db.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS shopper_id text'); // upgrade path for existing databases
  await db.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS sim_scenario text');
  await db.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS proposal_json jsonb');
  await db.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS preflight_decision text');
  await db.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS revocation_json jsonb');
  await db.query(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'GATE'`);
  return db;
}
