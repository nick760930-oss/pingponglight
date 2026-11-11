-- Leaderboard tables. Players have no account: ph is the SHA-256 of a random key kept on the phone.
CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  ph TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  nkey TEXT NOT NULL UNIQUE,         -- the name folded for uniqueness (names.js nameKey)
  seen INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
-- one best run per player per board (board = "<song key>-<difficulty>"); hid copies players.hidden
CREATE TABLE scores (
  board TEXT NOT NULL,
  pid INTEGER NOT NULL,
  key INTEGER NOT NULL,
  acc INTEGER NOT NULL,
  err INTEGER NOT NULL,
  combo INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  hid INTEGER NOT NULL DEFAULT 0,
  log TEXT,                          -- the beat log of this best run, kept for review
  pf TEXT,                           -- web / ios / android
  sus INTEGER NOT NULL DEFAULT 0,    -- unusually steady timing: listed for review
  PRIMARY KEY (board, pid)
);
CREATE INDEX scores_rank ON scores (board, hid, key DESC, ts);
CREATE INDEX scores_pid ON scores (pid);
-- one report per network (hashed) per player
CREATE TABLE reports (
  pid INTEGER NOT NULL,
  by TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (pid, by)
);
CREATE INDEX scores_sus ON scores (sus) WHERE sus = 1;
