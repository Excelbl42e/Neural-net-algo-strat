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
    // The retention prune filters on (timeframe, open_time). The only other
    // index leads with `symbol`, so the prune fell back to a sequential scan of
    // the whole candles table — 200ms at half a million rows, and growing every
    // hour it runs. This is the index it actually needs.
    sql`CREATE INDEX IF NOT EXISTS candles_tf_time_idx ON candles (timeframe, open_time)`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS small_account_max_risk_pct numeric(5,2) NOT NULL DEFAULT 10.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS min_risk_reward numeric(5,2) NOT NULL DEFAULT 1.50`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS atr_percentile_min numeric(5,2) NOT NULL DEFAULT 15.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS atr_percentile_max numeric(5,2) NOT NULL DEFAULT 90.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS efficiency_ratio_min numeric(5,3) NOT NULL DEFAULT 0.150`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS min_stop_atr numeric(5,2) NOT NULL DEFAULT 1.00`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS max_per_asset_class integer NOT NULL DEFAULT 14`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS news_blackout_before_min integer NOT NULL DEFAULT 30`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS news_blackout_after_min integer NOT NULL DEFAULT 30`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS max_spread_cost_pct numeric(5,2) NOT NULL DEFAULT 0.50`,
    sql`ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS max_position_hold_hours integer NOT NULL DEFAULT 96`,
    sql`ALTER TABLE bot_config ALTER COLUMN max_position_hold_hours SET DEFAULT 96`,
    sql`ALTER TABLE bot_config ALTER COLUMN min_confidence SET DEFAULT 0.500`,
    // Autotrade modes are now off | auto_demo | auto_live. The removed
    // manual_approval mode could never execute; autonomous maps to demo only.
    sql`UPDATE bot_config SET autotrade_mode = 'off' WHERE autotrade_mode NOT IN ('off','auto_demo','auto_live') AND autotrade_mode <> 'autonomous'`,
    sql`UPDATE bot_config SET autotrade_mode = 'auto_demo' WHERE autotrade_mode = 'autonomous'`,
    sql`ALTER TABLE bot_config ALTER COLUMN autotrade_mode SET DEFAULT 'off'`,
    // One-time rescale of the stored confidence threshold. The expert judge
    // replaced the LLM judge and produces confidence on a different scale
    // (0.35 base + confluence + structure, capped at 0.98), so a row still
    // holding the old 0.78 default is stricter than it was ever meant to be
    // and starves a small account of setups. Runs at most once: the marker
    // insert is the guard, and it only touches a row that still carries the
    // old default, never a threshold the operator has since chosen.
    sql`WITH once AS (
          INSERT INTO app_secrets (key, value)
          VALUES ('migration:min_confidence_rescale_v1', now()::text)
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        UPDATE bot_config SET min_confidence = 0.70
        WHERE min_confidence = 0.78 AND EXISTS (SELECT 1 FROM once)`,
    // One-time move to the settings chosen from the 2026-10-01 backtest
    // (three months of Deriv candles, all 14 pairs): reward:risk 1.5 judged at
    // the actual fill, and a 24-hour hold. The old 2.0 floor measured from the
    // FVG midpoint left the bot with 2 trades in three months. Runs at most
    // once, and only rewrites values still at the old defaults, so a figure
    // the operator chose afterwards is never overwritten.
    sql`WITH once AS (
          INSERT INTO app_secrets (key, value)
          VALUES ('migration:backtest_settings_v1', now()::text)
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        UPDATE bot_config SET
          min_risk_reward = CASE WHEN min_risk_reward = 2.00 THEN 1.50 ELSE min_risk_reward END,
          max_position_hold_hours = CASE WHEN max_position_hold_hours = 36 THEN 24 ELSE max_position_hold_hours END
        WHERE EXISTS (SELECT 1 FROM once)`,
    // One-time: min_confidence now means the strategy poll's agreement
    // threshold (share of voting strategies that must agree), not the retired
    // ICT judge's evidence score. v2 is the tuned poll: simple majority
    // (0.50) and a four-day hold, the settings chosen on the selection period.
    // A value the operator sets afterwards is never overwritten.
    sql`WITH once AS (
          INSERT INTO app_secrets (key, value)
          VALUES ('migration:strategy_poll_v2', now()::text)
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        UPDATE bot_config SET min_confidence = 0.50, max_position_hold_hours = 96
        WHERE EXISTS (SELECT 1 FROM once)`,
    // One-time: "risk per trade" now means the share of the balance a
    // stopped-out trade loses (the stake is sized from it), set to the 5%
    // chosen by the 2026-10-02 sizing backtest. A later choice is kept.
    sql`WITH once AS (
          INSERT INTO app_secrets (key, value)
          VALUES ('migration:risk_per_trade_loss_v1', now()::text)
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        UPDATE bot_config SET risk_per_trade_pct = 5.00
        WHERE EXISTS (SELECT 1 FROM once)`,
    // One-time: every majority vote opens a position (one per pair) until one
    // stake is left, as the operator asked, so the position ceilings go to 14
    // (the number of pairs). A later choice is kept.
    sql`WITH once AS (
          INSERT INTO app_secrets (key, value)
          VALUES ('migration:every_vote_until_reserve_v1', now()::text)
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        UPDATE bot_config SET max_concurrent_positions = 14, max_per_asset_class = 14
        WHERE EXISTS (SELECT 1 FROM once)`,
    sql`ALTER TABLE bot_config ALTER COLUMN max_concurrent_positions SET DEFAULT 14`,
    sql`ALTER TABLE bot_config ALTER COLUMN max_per_asset_class SET DEFAULT 14`,
    // Same upgrade: ICT signals still waiting for their entry when the poll
    // took over must not be traded by the replay pass afterwards.
    sql`WITH once AS (
          INSERT INTO app_secrets (key, value)
          VALUES ('migration:strategy_poll_pending_v1', now()::text)
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        UPDATE signals SET status = 'cancelled', execution_status = 'rejected',
          execution_reason = 'Retired ICT signal: the strategy poll replaced the ICT judge'
        WHERE status = 'active' AND execution_status = 'generated' AND dispatched_at IS NULL
          AND EXISTS (SELECT 1 FROM once)`,
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
