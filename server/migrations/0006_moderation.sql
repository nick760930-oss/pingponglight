-- Chat reports are judged by AI (moderate.js): status new -> busy (claimed) -> clear | upheld | review (a person decides).
-- freports is rebuilt without the UNIQUE (rp, target, mid): a judged report is never rewritten; new messages make a new row.
CREATE TABLE freports_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rp INTEGER NOT NULL,
  target INTEGER NOT NULL,
  mid INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  fts INTEGER NOT NULL DEFAULT 0,          -- time of the oldest reported message (mid = 0: the copy covers fts..mts)
  mts INTEGER NOT NULL DEFAULT 0,          -- time of the newest reported message
  ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  verdict TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  lease INTEGER NOT NULL DEFAULT 0
);
-- reports made before the rules and the AI review existed go to a person, never to automatic penalties
INSERT INTO freports_new (id, rp, target, mid, body, fts, mts, ts, status) SELECT id, rp, target, mid, body, ts, ts, ts, 'review' FROM freports;
DROP TABLE freports;
ALTER TABLE freports_new RENAME TO freports;
CREATE INDEX freports_target ON freports (target);
CREATE INDEX freports_rp ON freports (rp, target, mid);
CREATE INDEX freports_status ON freports (status);
-- Strikes and the current mute of free-text messages for a player (ts: when the last offence was counted;
-- pts: what it counted, 1 or 2). Removed 180 days after both the mute and the last offence (friendSweep).
CREATE TABLE fmutes (
  pid INTEGER PRIMARY KEY,
  strikes INTEGER NOT NULL,
  until INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  pts INTEGER NOT NULL DEFAULT 1
);
