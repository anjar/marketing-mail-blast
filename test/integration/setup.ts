// Integration tests exercise REAL PostgreSQL, Redis, BullMQ, Nodemailer and
// Mailpit (Constitution IX). They are skipped automatically unless the infra
// env vars are present (see helpers.ts `describeIntegration`).
jest.setTimeout(60000);
