-- Restoring a purchase on another account moves it (iap.js); mvts = when it last moved (0 = never), so one transaction moves at most once a day.
ALTER TABLE iaptx ADD COLUMN mvts INTEGER NOT NULL DEFAULT 0;
