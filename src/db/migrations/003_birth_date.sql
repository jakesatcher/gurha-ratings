-- Date of birth from roster exports; age is derived from it when present.
ALTER TABLE players ADD COLUMN birth_date date;
