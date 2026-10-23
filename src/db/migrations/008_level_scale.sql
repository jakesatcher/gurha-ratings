-- New rating scale: categories are rated by level with a Low/Mid/High step (points 0–15, D3 steps
-- are halves), and the rater gives one recommended level. Ratings made on the old 0–11 scale are
-- kept as scale 1 for reference but no longer count toward averages.
ALTER TABLE rating_scores ALTER COLUMN score TYPE numeric(4,1);
ALTER TABLE rating_scores ADD COLUMN grade text;
ALTER TABLE ratings ADD COLUMN scale smallint NOT NULL DEFAULT 1;
ALTER TABLE ratings ALTER COLUMN scale SET DEFAULT 2;
