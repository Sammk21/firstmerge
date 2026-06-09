/**
 * Ingest CLI — thin wrapper over lib/ingest.ts so the same pipeline powers both
 * `npm run ingest` and the dashboard's "Fetch latest data" button.
 *
 * Run:  npm run ingest
 * Free token (recommended, lifts limit to 5k/hr):
 *   export GITHUB_TOKEN=ghp_xxx   (classic PAT, no scopes needed for public data)
 */
import "dotenv/config";
import { runIngest } from "../lib/ingest";

runIngest({ log: (line) => console.log(line) })
  .then((s) => {
    if (!s.ok) {
      console.error("Ingest did not complete:", s.message);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
