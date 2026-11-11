SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);
