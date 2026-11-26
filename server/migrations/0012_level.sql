-- Levels, light energy (光能) and the light purchases (src/level.js). Only adds tables and columns.
-- prog: one row per player key hash (ph = SHA-256 of the phone's key), so players without a nickname have progress too and keep it when they register.
CREATE TABLE prog (
  ph TEXT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,                              -- total experience
  nat INTEGER NOT NULL DEFAULT 60, nts INTEGER NOT NULL,      -- natural light as last settled, and when
  sub INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0,   -- monthly-pass pool, bought pool (never expire, no cap)
  pass INTEGER NOT NULL DEFAULT 0,                            -- monthly pass expiry (ms; 0 = none)
  day INTEGER NOT NULL DEFAULT 0, dsec INTEGER NOT NULL DEFAULT 0, dspend INTEGER NOT NULL DEFAULT 0,   -- game day (04:00 Taiwan), play seconds and light spent that day
  mult INTEGER NOT NULL DEFAULT 1,                            -- the multiplier chosen last time
  lvr INTEGER NOT NULL DEFAULT 0,                             -- level rewards granted up to this level
  pleft INTEGER NOT NULL DEFAULT 0, pday INTEGER NOT NULL DEFAULT 0, psbx INTEGER NOT NULL DEFAULT 0,   -- the 30-day pass: pay days still to come, the last game day paid (dayOf), how many of the pending days came from a Sandbox purchase (paid last, log kind sbx_pass_day)
  lst INTEGER NOT NULL DEFAULT 0, len INTEGER NOT NULL DEFAULT 0,   -- start and end (ms) of the last run that earned experience: a run that overlaps it earns nothing
  created INTEGER NOT NULL
);
ALTER TABLE runs ADD COLUMN m INTEGER NOT NULL DEFAULT 1;     -- multiplier chosen when the run started
ALTER TABLE runs ADD COLUMN xp INTEGER NOT NULL DEFAULT 1;     -- 0 = a newer ticket of the same player replaced this one: it can still be used for the board, but earns no experience or light
ALTER TABLE runs ADD COLUMN ph TEXT;                          -- the player's key hash (always written by new code; the only owner of a pid = 0 ticket)
-- every change of light: buy, pass (monthly grant), refund, spend, wipe
CREATE TABLE lightlog (id INTEGER PRIMARY KEY AUTOINCREMENT, ph TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, pool TEXT NOT NULL, amt INTEGER NOT NULL, ref TEXT NOT NULL DEFAULT '');
CREATE INDEX lightlog_ph ON lightlog (ph);
-- unspent bought light of a player who deleted their data, kept for a year so a purchase can still be refunded within 30 days
CREATE TABLE wiped (ph TEXT PRIMARY KEY, ts INTEGER NOT NULL, paid INTEGER NOT NULL, sub INTEGER NOT NULL DEFAULT 0, pleft INTEGER NOT NULL DEFAULT 0);   -- sub: pass light unspent, pleft: pass days not yet paid
-- the original transaction id (kept for support; the monthly pass is a consumable now)
ALTER TABLE iaptx ADD COLUMN otx TEXT NOT NULL DEFAULT '';
CREATE INDEX iaptx_otx ON iaptx (otx);
-- App Store Server Notifications already handled (notificationUUID), so a replayed REFUND cannot undo a later REFUND_REVERSED. Rows are swept after 90 days.
CREATE TABLE iapnote (uuid TEXT PRIMARY KEY, ts INTEGER NOT NULL);
-- one row per player and duel round that gave experience (a retried round settles once)
CREATE TABLE duelxp (did TEXT NOT NULL, pid INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (did, pid));
