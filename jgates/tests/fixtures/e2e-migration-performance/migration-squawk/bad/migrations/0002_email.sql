SET lock_timeout = '1s';
SET statement_timeout = '5s';
ALTER TABLE users ADD COLUMN email text NOT NULL;
