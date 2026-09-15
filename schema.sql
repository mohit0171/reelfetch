-- ReelFetch MySQL schema
CREATE DATABASE IF NOT EXISTS reelfetch
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE reelfetch;

CREATE TABLE IF NOT EXISTS fetches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  platform ENUM('instagram','facebook','youtube','tiktok','unknown') NOT NULL DEFAULT 'unknown',
  source_url TEXT NOT NULL,
  title VARCHAR(500) NULL,
  thumbnail TEXT NULL,
  duration_sec INT NULL,
  width INT NULL,
  height INT NULL,
  filesize_bytes BIGINT NULL,
  status ENUM('ok','error') NOT NULL DEFAULT 'ok',
  error_message VARCHAR(500) NULL,
  client_ip VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform (platform),
  KEY idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS downloads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  fetch_id BIGINT UNSIGNED NULL,
  quality VARCHAR(32) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'started',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dl_fetch FOREIGN KEY (fetch_id)
    REFERENCES fetches (id) ON DELETE SET NULL,
  KEY idx_fetch (fetch_id)
) ENGINE=InnoDB;

-- Live stats: country-based tracking periods.
-- A NEW country arriving in the current period starts a new period (reset);
-- the country is then marked as seen for that period.
CREATE TABLE IF NOT EXISTS stats_periods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_started (started_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stats_period_countries (
  period_id BIGINT UNSIGNED NOT NULL,
  country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (period_id, country_code),
  CONSTRAINT fk_spc_period FOREIGN KEY (period_id)
    REFERENCES stats_periods (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Singleton row (id=1) pointing at the current period; also used as the
-- transaction lock (SELECT ... FOR UPDATE) that serializes arrivals.
CREATE TABLE IF NOT EXISTS stats_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  current_period_id BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
