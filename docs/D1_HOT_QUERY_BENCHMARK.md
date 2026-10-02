# D1 hot-query benchmark

Temporary diagnostic for the D1 Free daily row-read exhaustion.

The workflow `.github/workflows/audit-d1-hot-query-benchmark.yml` is read-only against application data. It runs bounded production-shaped `SELECT` probes one at a time and records Cloudflare D1 `meta.rows_read` plus `EXPLAIN QUERY PLAN` output.

It covers the recurring Worker hot paths (Phase A, cleanup, role queue, residual maintenance, EVENT persistence, embeddings, STORY matching) and the GitHub Actions full-content enrichment candidate query. It also records 24-hour collection/Phase-A run volume so expensive query cost can be multiplied by real execution/churn rather than configuration alone.

The scheduled trigger is intentionally gated to UTC date `2026-10-03`, shortly after the daily D1 quota reset. Manual dispatch remains available. The report is posted to diagnostic issue #91 and uploaded as a short-lived artifact.

This diagnostic does not update application tables and does not change the production Worker/cron behavior.
