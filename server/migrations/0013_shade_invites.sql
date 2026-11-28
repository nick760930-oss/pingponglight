-- Starshade (星影) and invitations (src/shade.js). Only adds a column and tables.
-- players.shade: 1 = this player's best runs may be shown to others as a "starshade" opponent (the player can turn it off in the settings).
ALTER TABLE players ADD COLUMN shade INTEGER NOT NULL DEFAULT 1;
-- invcodes: one invitation code per player (6 characters, never 0/O/1/I/L), made the first time it is asked for and then fixed.
CREATE TABLE invcodes (
  pid INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);
-- invites: who invited whom. invitee is the primary key, so a player can be invited only once. done = 1 when the invitee made their first clear
-- (both sides then get the hit effect 同行星芒); done_ts = when.
CREATE TABLE invites (
  invitee INTEGER PRIMARY KEY,
  inviter INTEGER NOT NULL,
  created INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_ts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invites_inviter ON invites (inviter);
