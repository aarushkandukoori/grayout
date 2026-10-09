-- Grayout's database, version 1. docs/API-CONTRACT.md section 12 explains
-- every table. Times are whole Unix seconds. Apply it with:
--   npx wrangler d1 migrations apply grayout --remote
--
-- Nothing here ever holds a license key, a device token, an IP address, an
-- email or a card number in clear, or an image. IPs, emails and card
-- fingerprints appear only as keyed hashes (HMAC with a Worker secret), which
-- this database cannot turn back into the value. A copy of it opens nothing.
--
-- v3 has never been deployed, so this file still holds the whole schema.
-- Once it has been applied anywhere, change the schema with a NEW file
-- (0002_….sql), never by editing this one.

-- One row per Stripe customer who has ever paid or started a trial.
CREATE TABLE licenses (
  id                    INTEGER PRIMARY KEY,
  key_hash              TEXT    NOT NULL UNIQUE,   -- hex SHA-256 of the key; the key itself is never stored
  generation            INTEGER NOT NULL DEFAULT 1,
  livemode              INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  customer_id           TEXT    NOT NULL UNIQUE,   -- cus_…: one license per customer
  subscription_id       TEXT,                      -- sub_… that the license follows
  status                TEXT    NOT NULL DEFAULT 'incomplete',  -- Stripe's raw subscription status
  billing_interval      TEXT    CHECK (billing_interval IN ('monthly', 'yearly')),
  period_start          INTEGER,                   -- items.data[0].current_period_start
  period_end            INTEGER,                   -- items.data[0].current_period_end
  trial_end             INTEGER,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  synced_at             INTEGER NOT NULL,          -- last time this row was written from a live Stripe read
  sync_tried_at         INTEGER,                   -- last time a re-read of Stripe was ATTEMPTED (even if it failed)
  trial_denied          INTEGER NOT NULL DEFAULT 0 CHECK (trial_denied IN (0, 1)),  -- 1: this card or email had a trial before
  created_at            INTEGER NOT NULL,
  revoked_at            INTEGER,
  revoked_reason        TEXT    CHECK (revoked_reason IN ('refund', 'dispute', 'fraud', 'manual'))
);
CREATE INDEX licenses_by_subscription ON licenses (subscription_id);

-- One row per minted device (a Mac running Grayout, or a browser on the site).
CREATE TABLE devices (
  device_id      TEXT    PRIMARY KEY,              -- dev_…
  created_at     INTEGER NOT NULL,
  mint_ip_hash   TEXT,                             -- HMAC(DEVICE_SECRET, ipKey), first 32 hex chars; cleared after 48 h
  free_used      INTEGER NOT NULL DEFAULT 0 CHECK (free_used >= 0),
  trial_used_at  INTEGER,                          -- set once this device started a trial or held a license
  license_id     INTEGER REFERENCES licenses (id), -- the license this device USES (/v1/restore returns it)
  bought_license_id INTEGER REFERENCES licenses (id), -- the license this device last BOUGHT (app or website);
                                                   -- only used to refuse a second purchase, never to serve or restore
  checkout_lock_at INTEGER,                        -- set while /v1/checkout runs for this device (one at a time)
  last_seen_at   INTEGER
);
CREATE INDEX devices_by_mint_ip ON devices (mint_ip_hash, created_at);
CREATE INDEX devices_by_license ON devices (license_id);
CREATE INDEX devices_by_bought_license ON devices (bought_license_id);

-- Polling handles for purchases started in the app.
CREATE TABLE device_codes (
  code        TEXT    PRIMARY KEY,                 -- 8 Crockford characters, stored without the dash
  device_id   TEXT    NOT NULL REFERENCES devices (device_id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX device_codes_by_device ON device_codes (device_id);

-- Every Checkout Session this service created. The only way a session maps to a device.
CREATE TABLE checkout_sessions (
  session_id   TEXT    PRIMARY KEY,                -- cs_…
  device_id    TEXT    NOT NULL REFERENCES devices (device_id),
  device_code  TEXT,                               -- set when the app started it
  plan         TEXT    NOT NULL CHECK (plan IN ('monthly', 'yearly')),
  trial        INTEGER NOT NULL CHECK (trial IN (0, 1)),
  livemode     INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  state        TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paid', 'failed', 'expired')),
  license_id   INTEGER REFERENCES licenses (id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  checked_at   INTEGER                             -- last time /v1/claim asked Stripe about it
);
CREATE INDEX checkout_sessions_by_code ON checkout_sessions (device_code);
CREATE INDEX checkout_sessions_by_device ON checkout_sessions (device_id, state);

-- Paid checks per license per calendar month (UTC).
CREATE TABLE usage (
  license_id  INTEGER NOT NULL REFERENCES licenses (id),
  month       TEXT    NOT NULL,                    -- 'YYYY-MM'
  n           INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  last_at     INTEGER NOT NULL DEFAULT 0,          -- time of the last served check
  PRIMARY KEY (license_id, month)
);

-- Free checks served to everyone, per UTC day.
CREATE TABLE free_budget (
  day  TEXT    PRIMARY KEY,                        -- 'YYYY-MM-DD'
  n    INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0)
);

-- Free checks per network per calendar month (UTC), whatever devices it mints.
CREATE TABLE free_network (
  net_hash  TEXT    NOT NULL,                      -- HMAC(DEVICE_SECRET, network key), first 32 hex chars
  month     TEXT    NOT NULL,                      -- 'YYYY-MM'; rows from past months are deleted daily
  n         INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (net_hash, month)
);

-- Free checks per IPv6 /48 block per UTC day. One /48 holds 256 networks
-- (/56), and some providers give a /48 away, so one block may take only a
-- small share of each day's budget. IPv4 has no rows here.
CREATE TABLE free_block (
  block_hash  TEXT    NOT NULL,                    -- HMAC(DEVICE_SECRET, '/48' key), first 32 hex chars
  day         TEXT    NOT NULL,                    -- 'YYYY-MM-DD'; deleted after 7 days
  n           INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (block_hash, day)
);

-- Who has had a free trial: keyed hashes of the buyer's email and card
-- fingerprint. A second trial with the same email or card ends at once.
CREATE TABLE trial_marks (
  mark         TEXT    PRIMARY KEY,                -- 'email:' or 'card:' + HMAC(LICENSE_SECRET, value), hex
  customer_id  TEXT    NOT NULL,                   -- the customer whose trial set this mark first
  created_at   INTEGER NOT NULL                    -- deleted after a year
);

-- Webhook events already handled, for de-duplication.
CREATE TABLE processed_events (
  event_id      TEXT    PRIMARY KEY,               -- evt_…
  type          TEXT    NOT NULL,
  processed_at  INTEGER NOT NULL
);
