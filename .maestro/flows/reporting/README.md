# Reporting flow prerequisites

`report-ai-illustration.yaml` requires an installed development/release build and the normal `TEST_EMAIL` / `TEST_PASSWORD` values. Set `REPORT_MEMORY_ID` to a ready illustrated memory in that account's active family. The account must not already have an active report for the memory's current illustration generation.

Run:

```bash
maestro test \
  -e TEST_EMAIL=... \
  -e TEST_PASSWORD=... \
  -e REPORT_MEMORY_ID=... \
  .maestro/flows/reporting/report-ai-illustration.yaml
```

The flow verifies the minimal overflow entry point, exact AI-illustration report, reporter-local hidden notice, and **Show anyway** behavior. Clean or resolve the test report before rerunning against the same generation.
