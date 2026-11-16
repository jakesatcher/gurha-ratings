-- The level the person contesting a rating thinks the player should be.
ALTER TABLE rating_contests ADD COLUMN requested_level text;
