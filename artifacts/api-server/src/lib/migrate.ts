import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
import { BOOTSTRAP_STATEMENTS } from "./bootstrap-sql.js";

/**
 * Idempotent boot-time schema upgrade so the app never depends on a manual
 * `drizzle-kit push`. Everything is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 */
export async function ensureSchema(): Promise<void> {
  // Fresh database: create every table (IF NOT EXISTS) so no manual `db push` is ever needed.
  for (const text of BOOTSTRAP_STATEMENTS) {
    try { await db.execute(sql.raw(text)); }
    catch (err) { logger.warn({ err: err instanceof Error ? err.message : String(err) }, "bootstrap statement skipped"); }
  }
  const stmts = [
    sql`CREATE TABLE IF NOT EXISTS app_owner (id serial PRIMARY KEY, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    sql`CREATE TABLE IF NOT EXISTS app_secrets (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
    sql`CREATE TABLE IF NOT EXISTS deriv_frames (id serial PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(), direction text NOT NULL, kind text NOT NULL, signal_id integer, contract_id text, payload text NOT NULL, ok boolean)`,
    sql`CREATE INDEX IF NOT EXISTS deriv_frames_received_idx ON deriv_frames (received_at DESC)`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS small_account_max_risk_pct numeric(5,2) NOT NULL DEFAULT 10.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS min_risk_reward numeric(5,2) NOT NULL DEFAULT 2.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS atr_percentile_min numeric(5,2) NOT NULL DEFAULT 15.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS atr_percentile_max numeric(5,2) NOT NULL DEFAULT 90.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS efficiency_ratio_min numeric(5,3) NOT NULL DEFAULT 0.150`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS min_stop_atr numeric(5,2) NOT NULL DEFAULT 1.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS max_per_asset_class integer NOT NULL DEFAULT 2`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS news_blackout_before_min integer NOT NULL DEFAULT 30`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS news_blackout_after_min integer NOT NULL DEFAULT 30`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS max_spread_cost_pct numeric(5,2) NOT NULL DEFAULT 0.50`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS max_position_hold_hours integer NOT NULL DEFAULT 96`,
    // Autotrade modes are now off | auto_demo | auto_live. The removed
    // manual_approval mode could never execute; autonomous maps to demo only.
    sql`UPDATE bot_config SET autotrade_mode = 'off' WHERE autotrade_mode NOT IN ('off','auto_demo','auto_live') AND autotrade_mode <> 'autonomous'`,
    sql`UPDATE bot_config SET autotrade_mode = 'auto_demo' WHERE autotrade_mode = 'autonomous'`,
    sql`ALTER TABLE bot_config ALTER COLUMN autotrade_mode SET DEFAULT 'off'`,
  ];
  for (const stmt of stmts) {
    try {
      await db.execute(stmt);
    } catch (err) {
      // Tables may not exist yet on a brand-new database; drizzle push creates them.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ensureSchema statement skipped");
    }
  }
}
