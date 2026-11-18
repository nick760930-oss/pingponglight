-- Single-use run tickets and challenge records (src/lb.js, src/ach.js). Only adds tables.
-- runs: one row per ticket the server issued to a registered player (/lb/start). done = 1 once the ticket was used by
-- /lb/submit or /lb/end, so a ticket cannot be used twice. Rows older than the ticket lifetime (3 hours) are deleted by /lb/start.
CREATE TABLE runs (
  nonce TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  song TEXT NOT NULL,
  d INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX runs_ts ON runs (ts);
CREATE INDEX runs_pid ON runs (pid);
-- tries: per player and chart (song + difficulty): ends = runs that ended (cleared, failed or quit), fails = runs that ended by running out of life.
CREATE TABLE tries (
  pid INTEGER NOT NULL,
  song TEXT NOT NULL,
  d INTEGER NOT NULL,
  ends INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pid, song, d)
);
