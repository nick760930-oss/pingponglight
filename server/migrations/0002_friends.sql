-- Friends. Everything refers to players.id; rows are removed by friendWipe() when a player deletes their data.
-- Friend code: 8 characters, created lazily on the first /fr/me call, one per player.
CREATE TABLE fcodes (
  pid INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE
);
-- A friendship is stored ONCE per pair with a < b (the code always sorts the two ids), so there is no
-- second row to keep in sync; reading a player's friends is two index lookups (a = me, b = me).
CREATE TABLE fships (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX fships_b ON fships (b);
-- Pending friend requests: frm asked "to". Direction matters, so one row per request.
CREATE TABLE freqs (
  frm INTEGER NOT NULL,
  "to" INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (frm, "to")
);
CREATE INDEX freqs_to ON freqs ("to");
-- pid blocked target (one direction; add checks both).
CREATE TABLE fblocks (
  pid INTEGER NOT NULL,
  target INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (pid, target)
);
CREATE INDEX fblocks_target ON fblocks (target);
