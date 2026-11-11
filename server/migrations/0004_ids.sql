-- Player ids are never reused after a player deletes their data (AUTOINCREMENT), so hide lists and
-- live friend sockets that still hold an old id cannot point at a new player.
CREATE TABLE players_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ph TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  nkey TEXT NOT NULL UNIQUE,
  seen INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
INSERT INTO players_new (id, ph, name, nkey, seen, hidden, created) SELECT id, ph, name, nkey, seen, hidden, created FROM players;
DROP TABLE players;
ALTER TABLE players_new RENAME TO players;
-- reports: the reporting player, so one player on several networks still counts once
ALTER TABLE reports ADD COLUMN rp INTEGER;
CREATE UNIQUE INDEX reports_rp ON reports (pid, rp);
