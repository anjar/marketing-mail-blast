-- Throughput profile: VALID, UNIQUE recipients only. No malformed rows here
-- (Constitution VII / plan: never mix malformed rows into throughput benchmarks).
-- Generated entirely server-side with generate_series — nothing passes through
-- Node.js memory.
--
-- Usage:
--   psql "$DATABASE_URL" -v scale=1000    -f dummy/10_seed_throughput.sql
--   psql "$DATABASE_URL" -v scale=1000000 -f dummy/10_seed_throughput.sql
-- Values above 1,000,000 are supported by passing a larger -v scale=...

\set scale :scale

INSERT INTO "Recipient" ("email", "name", "createdAt", "updatedAt")
SELECT
  'user' || g || '@example.com',
  'Name' || g,
  now(),
  now()
FROM generate_series(1, :scale) AS g;

\echo 'Seeded throughput recipients:'
SELECT count(*) AS throughput_recipients FROM "Recipient";
