-- Verified duel results (src/duel.js, src/arena.js, src/ach.js). Only adds tables and columns.
-- duels: one row per finished multiplayer round that counted (at least 2 valid seats). id is made when the round starts, so a retried write is harmless
--   (INSERT OR IGNORE). void = 1 when an admin took the round back (lb.js /lb/admin op duelvoid). log1 = the winner's beat log, kept for a manual check.
-- duelp: one row per valid seat, with the flags the achievements read (fixed at the moment of settling; later friend changes do not rewrite them).
-- Deleting an account deletes its duelp rows and clears log1 of the rounds it won (lb.js wipe); the rest of duels holds no personal data and stays.
CREATE TABLE duels (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  day INTEGER NOT NULL,         -- Taiwan day number: floor((ts + 8h) / 86400000)
  song TEXT NOT NULL, d INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'qm' quick match / 'room' private room
  host INTEGER,                 -- the host's pid when the round started (NULL: not signed in)
  seats INTEGER NOT NULL,       -- seats when the round started
  valid INTEGER NOT NULL,       -- valid seats
  void INTEGER NOT NULL DEFAULT 0,
  log1 TEXT                     -- the first place's beat log (kept to check for cheating; cleared when that player deletes the account)
);
CREATE TABLE duelp (
  did TEXT NOT NULL, pid INTEGER NOT NULL,
  place INTEGER NOT NULL,       -- place on the result screen (1 = first)
  acc INTEGER NOT NULL, score INTEGER NOT NULL,
  ok INTEGER NOT NULL,          -- finished the whole song
  fc INTEGER NOT NULL,          -- full combo
  q INTEGER NOT NULL,           -- mean points per hit, normalised, x100 (src/duel.js)
  sus INTEGER NOT NULL DEFAULT 0,
  cg INTEGER NOT NULL,          -- counts as a played round
  cw INTEGER NOT NULL,          -- counts as a win
  fr INTEGER NOT NULL,          -- friends among the valid opponents when settled
  eq INTEGER NOT NULL,          -- same accuracy as another finisher (知音)
  cb INTEGER NOT NULL,          -- last at 90 %, first at the end (最終樂章)
  s8 INTEGER NOT NULL,          -- started with 8 seats and at least 6 valid opponents
  f8 INTEGER NOT NULL,          -- s8, and the other 7 seats were all friends of this player at the start
  qual INTEGER NOT NULL DEFAULT 0,  -- this seat counted as a qualified opponent in that round (3+ songs on the board; a log with 30 % hits, or left after 30 % of the beats with a score above 0); the number of different opponents beaten only counts these
  PRIMARY KEY (did, pid)
);
CREATE INDEX duelp_pid ON duelp (pid);
CREATE INDEX duels_ts ON duels (ts);
ALTER TABLE fships ADD COLUMN "by" INTEGER;      -- who sent the friend request (NULL on older rows)
ALTER TABLE fships ADD COLUMN fresh INTEGER;   -- 1 = when the friendship began, the OTHER side had no score at all (引路人)
