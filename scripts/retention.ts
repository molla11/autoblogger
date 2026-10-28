import "reflect-metadata";
import { ApiService, type User } from "../apps/api/src/service";
import { one } from "../apps/api/src/db";

// Run on the API host with the same server-only environment and storage mounts.
// Default is a count-only preview; --run performs the documented 90-day cleanup.
async function main() {
  const api = await new ApiService().init();
  try {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const result = await api.db.query(
      "SELECT count(*) AS count FROM events WHERE data->>'occurredAt'<$1",
      [cutoff],
    );
    if (!process.argv.includes("--run")) {
      console.log({
        dryRun: true,
        cutoff,
        expiredEvents: Number(result.rows[0].count),
      });
      return;
    }
    const admin: User | undefined = process.env.ADMIN_USER_ID
      ? await one(api.db, "users", process.env.ADMIN_USER_ID)
      : (
          await api.db.query(
            "SELECT data FROM users WHERE data->>'role'='admin' ORDER BY id LIMIT 1",
          )
        ).rows[0]?.data;
    if (!admin || admin.role !== "admin")
      throw new Error(
        "An existing administrator account is required for retention cleanup",
      );
    console.log(await api.retention(admin));
  } finally {
    await api.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
