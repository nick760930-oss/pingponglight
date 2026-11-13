-- Friend messages (free text, friends only). Kept 7 days (FMSG_KEEP in friends.js); removed with the friendship,
-- a block, or the player's data deletion (friendWipe).
CREATE TABLE fmsgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frm INTEGER NOT NULL,
  "to" INTEGER NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX fmsgs_frm ON fmsgs (frm, "to", ts);
CREATE INDEX fmsgs_to ON fmsgs ("to", ts);
CREATE INDEX fmsgs_ts ON fmsgs (ts);
-- Reports about a player from the chat (rp reported target). body is a copy of the reported message, so it can be
-- checked by hand after the message itself has expired. One report per reporter, target and message.
CREATE TABLE freports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rp INTEGER NOT NULL,
  target INTEGER NOT NULL,
  mid INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  ts INTEGER NOT NULL,
  UNIQUE (rp, target, mid)
);
CREATE INDEX freports_target ON freports (target);
