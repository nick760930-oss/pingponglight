-- Bug reports from testers (/bug/send): a kind, an optional description, device details the player saw before
-- sending, and up to 3 images kept apart in bugimgs. Kept 180 days (bugSweep), then deleted.
-- pid: the reporter's player id when they have a nickname (NULL otherwise); by: hashed network key for the daily cap;
-- sz: total image bytes, for the server-wide storage caps.
CREATE TABLE bugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pid INTEGER,
  by TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  n INTEGER NOT NULL DEFAULT 0,
  sz INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX bugs_ts ON bugs (ts);
CREATE INDEX bugs_pid ON bugs (pid);
CREATE INDEX bugs_by ON bugs (by, ts);
CREATE TABLE bugimgs (
  bug INTEGER NOT NULL,
  i INTEGER NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (bug, i)
);
