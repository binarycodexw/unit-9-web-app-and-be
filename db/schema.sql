-- WatchSecure schema. Can be run more than once.

-- users: passwords are Argon2id hashes, the MFA secret is encrypted by the app
CREATE TABLE IF NOT EXISTS users (
    id                    SERIAL PRIMARY KEY,
    email                 VARCHAR(254) NOT NULL,
    password_hash         TEXT         NOT NULL,
    role                  VARCHAR(10)  NOT NULL DEFAULT 'user',
    mfa_enabled           BOOLEAN      NOT NULL DEFAULT FALSE,
    mfa_secret_encrypted  TEXT,
    mfa_last_time_step    BIGINT,
    failed_login_attempts INTEGER      NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT users_role_check  CHECK (role IN ('user', 'admin')),
    CONSTRAINT users_email_check CHECK (email = lower(email) AND position('@' IN email) > 1),
    CONSTRAINT users_mfa_check   CHECK (mfa_enabled = FALSE OR mfa_secret_encrypted IS NOT NULL),
    CONSTRAINT users_failed_check CHECK (failed_login_attempts >= 0)
);

-- the check forces lower case, so emails are unique regardless of case
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

-- stocks: catalogue managed by admins
CREATE TABLE IF NOT EXISTS stocks (
    id             SERIAL PRIMARY KEY,
    symbol         VARCHAR(10)   NOT NULL,
    name           VARCHAR(120)  NOT NULL,
    exchange       VARCHAR(30)   NOT NULL DEFAULT 'NASDAQ',
    sector         VARCHAR(60)   NOT NULL DEFAULT 'Other',
    last_price     NUMERIC(14,4),
    last_price_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT stocks_symbol_check CHECK (symbol ~ '^[A-Z][A-Z0-9.\-]{0,9}$'),
    CONSTRAINT stocks_price_check  CHECK (last_price IS NULL OR last_price >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS stocks_symbol_key ON stocks (symbol);
CREATE INDEX IF NOT EXISTS stocks_sector_idx ON stocks (sector);

-- price_history: one candle per stock per day
CREATE TABLE IF NOT EXISTS price_history (
    id          BIGSERIAL PRIMARY KEY,
    stock_id    INTEGER       NOT NULL REFERENCES stocks (id) ON DELETE CASCADE,
    trade_date  DATE          NOT NULL,
    open_price  NUMERIC(14,4) NOT NULL,
    high_price  NUMERIC(14,4) NOT NULL,
    low_price   NUMERIC(14,4) NOT NULL,
    close_price NUMERIC(14,4) NOT NULL,
    volume      BIGINT        NOT NULL DEFAULT 0,
    CONSTRAINT price_history_prices_check CHECK (
        open_price >= 0 AND high_price >= low_price AND low_price >= 0 AND close_price >= 0
    ),
    CONSTRAINT price_history_volume_check CHECK (volume >= 0),
    CONSTRAINT price_history_unique_day UNIQUE (stock_id, trade_date)
);

CREATE INDEX IF NOT EXISTS price_history_stock_date_idx
    ON price_history (stock_id, trade_date DESC);

-- watchlists: owned by one user
CREATE TABLE IF NOT EXISTS watchlists (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       VARCHAR(60)  NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT watchlists_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT watchlists_unique_name UNIQUE (user_id, name)
);

-- watchlist_items: links watchlists and stocks (many to many), plus note and target price
CREATE TABLE IF NOT EXISTS watchlist_items (
    id            SERIAL PRIMARY KEY,
    watchlist_id  INTEGER       NOT NULL REFERENCES watchlists (id) ON DELETE CASCADE,
    stock_id      INTEGER       NOT NULL REFERENCES stocks (id) ON DELETE CASCADE,
    note          VARCHAR(500)  NOT NULL DEFAULT '',
    target_price  NUMERIC(14,4),
    added_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT watchlist_items_target_check CHECK (target_price IS NULL OR target_price > 0),
    CONSTRAINT watchlist_items_unique UNIQUE (watchlist_id, stock_id)
);

CREATE INDEX IF NOT EXISTS watchlist_items_stock_idx ON watchlist_items (stock_id);

-- security_events: audit log. user_id is not a foreign key on purpose,
-- the history has to stay after an account is deleted
CREATE TABLE IF NOT EXISTS security_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INTEGER,
    event_type VARCHAR(40)  NOT NULL,
    ip_address VARCHAR(45),
    details    VARCHAR(300) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events (user_id);

-- session: table used by connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
    sid    VARCHAR      NOT NULL PRIMARY KEY,
    sess   JSON         NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON "session" (expire);
