# D1 query insights audit

This temporary diagnostic documents the read-only workflow `.github/workflows/audit-d1-query-insights.yml`.

It uses `wrangler d1 insights club-actu-db` to rank captured D1 query fingerprints by:

- total rows read;
- average rows read per execution;
- execution count.

The workflow reads Cloudflare's D1 analytics/insights dataset and does **not** replay the captured SQL statements against the application database.

The immediate purpose is to identify the queries responsible for exhausting the Workers Free account-wide D1 daily row-read allowance. Once the hot query or queries are identified and fixed, this diagnostic can be kept as an on-demand operational tool or removed.
