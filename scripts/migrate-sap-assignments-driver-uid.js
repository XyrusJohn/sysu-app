// Safe v2 runner: explicit project assertion; dry-run by default; atomic before-image backup on apply.
const {
  runMigrationCli,
} = require("../backend/src/migrations/releaseMigration");
if (require.main === module) void runMigrationCli("driver-uid");
