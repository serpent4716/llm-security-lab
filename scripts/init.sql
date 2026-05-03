-- LLM Security Lab — Database Initialization
-- Runs once when Postgres container first starts

-- Create tables explicitly (SQLAlchemy also does this, but belt-and-suspenders)
CREATE TABLE IF NOT EXISTS attempts (
    id            SERIAL PRIMARY KEY,
    session_id    VARCHAR(64) NOT NULL,
    ip_address    VARCHAR(45) NOT NULL,
    level         INTEGER NOT NULL,
    user_prompt   TEXT NOT NULL,
    llm_response  TEXT,
    is_successful BOOLEAN DEFAULT FALSE NOT NULL,
    tokens_used   INTEGER DEFAULT 0,
    response_ms   INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS completions (
    id            SERIAL PRIMARY KEY,
    session_id    VARCHAR(64) NOT NULL,
    level         INTEGER NOT NULL,
    attempts_used INTEGER DEFAULT 1,
    completed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_attempts_session    ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_level      ON attempts(level);
CREATE INDEX IF NOT EXISTS idx_completions_session ON completions(session_id);

-- Prevent duplicate completions
CREATE UNIQUE INDEX IF NOT EXISTS idx_completions_unique
    ON completions(session_id, level);

COMMENT ON TABLE attempts    IS 'Every prompt submission with judge result';
COMMENT ON TABLE completions IS 'First successful solve per session per level';
