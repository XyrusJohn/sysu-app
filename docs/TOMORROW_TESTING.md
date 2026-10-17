# Testing setup (historical)

This file replaces a workstation-specific setup note dated 2026-10-09. The old instructions targeted existing Firebase Auth, database, and hosted services, so they are not safe or verified as general test instructions.

Use the current project manifests and test scripts with an explicitly isolated emulator configuration. For migration work, follow [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md). Confirm the selected Firebase project and emulator endpoints before running any integration test; never point tests at production data. This page does not certify any workstation configuration or test result.
