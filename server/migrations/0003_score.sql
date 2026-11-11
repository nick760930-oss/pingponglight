-- Score breaks ties between equal accuracy (lb.js judge). key = accuracy (basis points) * 1e9 + score.
ALTER TABLE scores ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
