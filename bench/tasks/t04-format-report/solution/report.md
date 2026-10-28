# Status Report

## Summary

The latest deployment increased login latency and triggered several operational alerts; the checkout path is the main suspect and a short-lived cache is planned.

## Findings

- Login latency p95 rose to 1.2 seconds after the deployment and stayed elevated for the whole observation window.
- Retry storms appeared 42 times in the last hour, mostly from clients that timed out against the checkout endpoint.
- Three checkout alerts fired overnight, all correlated with the same retry pattern.
- A short-lived cache was chosen as the first mitigation because it reduces upstream pressure without changing the API contract.

## Next steps

- Measure p99 latency before and after the cache, and keep the p95 comparison for the same time window.
- Write the on-call runbook for retry storms, including the rollback and cache-disable steps.
