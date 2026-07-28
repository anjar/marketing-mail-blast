-- Validation profile: controlled invalid emails, missing/blank names, and
-- duplicate normalized addresses. Deterministic counts so verify scripts can
-- assert exact dispositions. generate_series only; no Node.js memory.
--
-- Usage: psql "$DATABASE_URL" -f dummy/20_seed_validation.sql
-- Produces (defaults, N=100 base rows per class):
--   * 100 valid unique
--   * 100 duplicate normalized (case/whitespace variants of the valid set) -> DUPLICATE_EMAIL
--   *  50 invalid-format emails                                            -> EMAIL_INVALID_FORMAT
--   *  50 missing/blank/whitespace emails                                  -> EMAIL_MISSING
--   *  30 valid emails with missing/blank names (personalization fallback = Customer)

BEGIN;

-- 1) Valid unique baseline
INSERT INTO "Recipient" ("email", "name", "createdAt", "updatedAt")
SELECT 'valid' || g || '@example.com', 'Person' || g, now(), now()
FROM generate_series(1, 100) AS g;

-- 2) Duplicates of the baseline via case + surrounding whitespace variants.
--    Normalized (trim+lowercase) they collide with row 1) -> later ids rejected DUPLICATE_EMAIL.
INSERT INTO "Recipient" ("email", "name", "createdAt", "updatedAt")
SELECT '  VALID' || g || '@Example.COM  ', 'Dup' || g, now(), now()
FROM generate_series(1, 100) AS g;

-- 3) Invalid-format emails -> EMAIL_INVALID_FORMAT
INSERT INTO "Recipient" ("email", "name", "createdAt", "updatedAt")
SELECT
  CASE (g % 5)
    WHEN 0 THEN 'no-at-sign' || g
    WHEN 1 THEN 'spaces in@ex.com'
    WHEN 2 THEN 'double@@ex.com'
    WHEN 3 THEN 'nodot@examplecom'
    ELSE 'trailingdot@ex.'
  END,
  'Invalid' || g, now(), now()
FROM generate_series(1, 50) AS g;

-- 4) Missing / blank / whitespace-only emails -> EMAIL_MISSING
INSERT INTO "Recipient" ("email", "name", "createdAt", "updatedAt")
SELECT
  CASE (g % 3) WHEN 0 THEN NULL WHEN 1 THEN '' ELSE '   ' END,
  'NoEmail' || g, now(), now()
FROM generate_series(1, 50) AS g;

-- 5) Valid emails with missing/blank names -> personalization uses 'Customer'
INSERT INTO "Recipient" ("email", "name", "createdAt", "updatedAt")
SELECT 'noname' || g || '@example.com',
  CASE (g % 3) WHEN 0 THEN NULL WHEN 1 THEN '' ELSE '   ' END,
  now(), now()
FROM generate_series(1, 30) AS g;

COMMIT;

\echo 'Seeded validation fixtures.'
