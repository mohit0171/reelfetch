/* Live stats with country-based tracking periods.
   Counters (Downloads / Fetches / Users) are computed from the existing
   `fetches` / `downloads` tables, filtered by the current tracking period's
   start time. When a request arrives from a country that is NOT yet seen in
   the current period, a new period starts (all counters go back to 0) and
   that country is marked as seen — so it never resets again until another
   NEW country arrives.

   Concurrency: the singleton row in `stats_state` is locked with
   SELECT ... FOR UPDATE inside a transaction, so simultaneous arrivals are
   serialized — a country can never trigger more than one reset, and the
   check + reset + mark-seen sequence is atomic. */

require('dotenv').config();
const { pool } = require('./db');

let schemaReady = false;

/* Create the tracking-period tables if missing (also runs on startup so the
   reset state survives page refreshes and server restarts without having to
   re-run setup-db). Non-fatal — the API keeps working if MySQL is down. */
async function ensureStatsSchema() {
  if (schemaReady) return true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS stats_periods (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_started (started_at)
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stats_period_countries (
      period_id BIGINT UNSIGNED NOT NULL,
      country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (period_id, country_code),
      CONSTRAINT fk_spc_period FOREIGN KEY (period_id)
        REFERENCES stats_periods (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stats_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      current_period_id BIGINT UNSIGNED NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await pool.query(`INSERT IGNORE INTO stats_state (id, current_period_id) VALUES (1, NULL)`);
    schemaReady = true;
    return true;
  } catch (err) {
    console.warn('[stats] schema setup failed:', err.message);
    return false;
  }
}

const normalizeCountry = (c) => {
  const code = String(c || '').trim().toUpperCase().slice(0, 2);
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

/* Register activity (a fetch or a download) from `countryCode`.
   Starts the first period if none exists, and starts a NEW period (reset to
   0) only when `countryCode` is genuinely new to the current period.
   Returns { reset, periodId, periodStartedAt } or null on DB failure. */
async function recordActivity(countryCode) {
  if (!(await ensureStatsSchema())) return null;

  const country = normalizeCountry(countryCode);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    /* Serialize concurrent arrivals on the singleton state row. */
    const [stateRows] = await conn.query(
      `SELECT current_period_id FROM stats_state WHERE id = 1 FOR UPDATE`
    );
    let periodId = stateRows.length ? stateRows[0].current_period_id : null;

    if (!periodId) {
      /* Very first activity ever → open the initial tracking period. */
      const [ins] = await conn.query(`INSERT INTO stats_periods () VALUES ()`);
      periodId = ins.insertId;
      if (stateRows.length) {
        await conn.query(`UPDATE stats_state SET current_period_id = ? WHERE id = 1`, [periodId]);
      } else {
        await conn.query(`INSERT INTO stats_state (id, current_period_id) VALUES (1, ?)`, [periodId]);
      }
    }

    let reset = false;

    if (country) {
      const [seenRows] = await conn.query(
        `SELECT 1 AS seen FROM stats_period_countries
          WHERE period_id = ? AND country_code = ? FOR UPDATE`,
        [periodId, country]
      );

      if (!seenRows.length) {
        /* NEW country in this period → reset: open a fresh period starting
           NOW, mark this country as seen in it, and make it current. */
        const [ins] = await conn.query(`INSERT INTO stats_periods (started_at) VALUES (NOW())`);
        const newPeriodId = ins.insertId;
        await conn.query(
          `INSERT INTO stats_period_countries (period_id, country_code) VALUES (?, ?)`,
          [newPeriodId, country]
        );
        await conn.query(`UPDATE stats_state SET current_period_id = ? WHERE id = 1`, [newPeriodId]);
        periodId = newPeriodId;
        reset = true;
      }
    }

    const [pRows] = await conn.query(`SELECT started_at FROM stats_periods WHERE id = ?`, [periodId]);
    const periodStartedAt = pRows.length ? pRows[0].started_at : null;

    await conn.commit();
    return { reset, periodId, periodStartedAt };
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.warn('[stats] recordActivity failed:', err.message);
    return null;
  } finally {
    conn.release();
  }
}

/* Current live stats, counted since the current period's start.
   Returns { fetches, downloads, users, countries, periodId, periodStartedAt }
   or null on DB failure. The static "avg. fetch time" shown on the site is
   NOT part of this — it is untouched and never reset. */
async function getLiveStats() {
  if (!(await ensureStatsSchema())) return null;
  try {
    const [stateRows] = await pool.query(
      `SELECT s.current_period_id AS periodId, p.started_at
         FROM stats_state s JOIN stats_periods p ON p.id = s.current_period_id
        WHERE s.id = 1`
    );

    if (!stateRows.length) {
      return { fetches: 0, downloads: 0, users: 0, countries: 0, periodId: null, periodStartedAt: null };
    }

    const { periodId, started_at: periodStartedAt } = stateRows[0];

    const [f] = await pool.query(
      `SELECT COUNT(*) AS c FROM fetches WHERE status = 'ok' AND created_at >= ?`,
      [periodStartedAt]
    );
    const [d] = await pool.query(
      `SELECT COUNT(*) AS c FROM downloads WHERE created_at >= ?`,
      [periodStartedAt]
    );
    const [u] = await pool.query(
      `SELECT COUNT(DISTINCT client_ip) AS c FROM fetches
        WHERE status = 'ok' AND created_at >= ? AND client_ip IS NOT NULL AND client_ip != ''`,
      [periodStartedAt]
    );
    const [co] = await pool.query(
      `SELECT COUNT(*) AS c FROM stats_period_countries WHERE period_id = ?`,
      [periodId]
    );

    return {
      fetches: f[0].c,
      downloads: d[0].c,
      users: u[0].c,
      countries: co[0].c,
      periodId,
      periodStartedAt,
    };
  } catch (err) {
    console.warn('[stats] getLiveStats failed:', err.message);
    return null;
  }
}

module.exports = { ensureStatsSchema, recordActivity, getLiveStats };