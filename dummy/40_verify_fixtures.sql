-- Verify validation-fixture composition (T061). Asserts the deterministic counts
-- produced by 20_seed_validation.sql BEFORE any campaign runs, using the same
-- normalization the app applies (trim + lowercase).
--
-- Expected against a fresh validation seed:
--   normalized_duplicates_groups = 100 (each valid<g> collides with its VALID<g> variant)
--   invalid_format_candidates    = 50
--   missing_email                = 50
--   blank_name_valid_email       = 30

WITH norm AS (
  SELECT id, lower(btrim(email)) AS n, name FROM "Recipient"
)
SELECT
  (SELECT count(*) FROM "Recipient" WHERE email IS NULL OR btrim(email) = '')
    AS missing_email,
  (SELECT count(*) FROM (
      SELECT n FROM norm WHERE n IS NOT NULL AND n <> ''
      GROUP BY n HAVING count(*) > 1
   ) d) AS normalized_duplicate_groups,
  (SELECT count(*) FROM norm
     WHERE n IS NOT NULL AND n <> ''
       AND n !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    AS invalid_format_candidates,
  (SELECT count(*) FROM "Recipient"
     WHERE (email IS NOT NULL AND btrim(email) <> '')
       AND (name IS NULL OR btrim(name) = ''))
    AS blank_name_valid_email;
