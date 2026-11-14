-- Shop, cosmetics, achievements and in-app purchases (docs/shop-spec.md).
-- What other players see: the equipped avatar, name plate and title (players.avatar/plate/title; '' = the default one).
ALTER TABLE players ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE players ADD COLUMN plate TEXT NOT NULL DEFAULT '';
ALTER TABLE players ADD COLUMN title TEXT NOT NULL DEFAULT '';
-- Ownership. One row per source, so the same item bought AND earned stays owned when one source goes away.
-- src: iap (ref = transaction id), ach (ref = achievement id), sponsor (sponsoring total), test (free test period; void once SHOP_TEST is not 1).
CREATE TABLE ents (
  pid INTEGER NOT NULL,
  item TEXT NOT NULL,
  src TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  PRIMARY KEY (pid, item, src, ref)
);
-- Verified App Store transactions (deduplicated by transaction id). pid = 0 after the player deleted their data (the
-- transaction stays known so its receipt cannot be used again). amt: NT$ of a sponsor pack (consumable), else 0.
CREATE TABLE iaptx (
  txid TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  product TEXT NOT NULL,
  env TEXT NOT NULL,
  ts INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  amt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX iaptx_pid ON iaptx (pid);
-- Achievements a player has. loc = 1: decided on the phone (the server only records it, nothing others can see is given for it).
CREATE TABLE achs (
  pid INTEGER NOT NULL,
  ach TEXT NOT NULL,
  ts INTEGER NOT NULL,
  loc INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pid, ach)
);
-- Running totals over every accepted run (the leaderboard keeps only the best run per board): hits and perfect hits.
CREATE TABLE pstats (
  pid INTEGER PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  perf INTEGER NOT NULL DEFAULT 0
);
-- scores: n = accepted (cleared) runs of this board; ft = details of the best run for achievements (ach.js), JSON, filled in on submit
-- (NULL on older rows: ach.js fills it in from the stored beat log the first time it is needed).
ALTER TABLE scores ADD COLUMN n INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scores ADD COLUMN ft TEXT;
