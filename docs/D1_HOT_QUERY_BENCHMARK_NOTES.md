# D1 benchmark invariants

- Diagnostic only; no production application write path is changed.
- Application probes are `SELECT` statements; query plans are collected with `EXPLAIN QUERY PLAN`.
- Each probe runs independently so `meta.rows_read` can be attributed to one hot path.
- The benchmark must not be used as evidence to change STORY thresholds or EVENT extraction policy.
- Any follow-up optimization must preserve queue bounds, idempotence and current business semantics.
