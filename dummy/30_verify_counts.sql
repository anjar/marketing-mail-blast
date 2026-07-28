-- Verify raw recipient row counts (scale sanity check).
SELECT count(*) AS total_recipients FROM "Recipient";
SELECT
  count(*) FILTER (WHERE email IS NULL OR btrim(email) = '') AS blank_or_missing_email,
  count(*) FILTER (WHERE email IS NOT NULL AND btrim(email) <> '') AS non_blank_email
FROM "Recipient";
