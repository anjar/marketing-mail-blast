# Dummy Data Generators

Server-side SQL generators (PostgreSQL `generate_series`). **No generated recipient data is
committed** — only these scripts. Nothing passes through Node.js memory.

## Scripts

| Script | Purpose |
|--------|---------|
| `00_clear.sql` | Clear all campaign + recipient test data (TRUNCATE CASCADE). |
| `10_seed_throughput.sql` | Seed N **valid, unique** recipients. Parameterized: `-v scale=N`. No malformed rows. |
| `20_seed_validation.sql` | Seed controlled invalid / missing-name / blank-name / duplicate fixtures. |
| `30_verify_counts.sql` | Verify raw recipient row counts. |
| `40_verify_fixtures.sql` | Verify duplicate + invalid + missing fixture composition. |

## Usage

```bash
export DATABASE_URL=postgresql://mailblast:mailblast@localhost:5432/mailblast

# Clear, then seed a scale (1k / 10k / 100k / 1M / >1M)
psql "$DATABASE_URL" -f dummy/00_clear.sql
psql "$DATABASE_URL" -v scale=1000    -f dummy/10_seed_throughput.sql
psql "$DATABASE_URL" -f dummy/30_verify_counts.sql

# Validation correctness fixtures
psql "$DATABASE_URL" -f dummy/00_clear.sql
psql "$DATABASE_URL" -f dummy/20_seed_validation.sql
psql "$DATABASE_URL" -f dummy/40_verify_fixtures.sql
```

**Do not** mix the validation fixtures into a throughput benchmark unless the test explicitly
measures validation behavior.
