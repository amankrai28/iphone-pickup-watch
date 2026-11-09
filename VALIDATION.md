# Validation

Sanitized source checked November 9, 2026 using the original project's installed locked dependencies (Node.js 25.8.1).

- 138 unit tests passed, no skips or failures.
- Worker dry-run emitted the bundle successfully and reported `--dry-run: exiting now`. A subsequent registry request was blocked by the execution environment, so clean network dependency installation was not verified.
- Worker/SQLite runtime, phone Web Push, checkout coordination and legacy native runtime fixture suites all passed. These fixtures mock external services and do not send real stock alerts or make purchases.
- Release allowlist excludes dependencies, build output, credentials, runtime state, private audits and generated launchers.
- Text review removed known deployment/account URLs, original location ZIP, owner card suffix and personal order identifier. Remaining fixture secrets and order IDs are synthetic test data.

No deployment, live polling, push notification or purchase was performed for this validation. Review provider requirements and configure a separate installation before use. No open-source license has been selected.
