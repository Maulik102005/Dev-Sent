import { cancelRun, createDatabase, getRunDetail, listRecentRuns, requestRunRecovery } from "../packages/database/src/index.js";
const db = createDatabase(process.env.DATABASE_URL!);
try {
  const [command = "list", id] = process.argv.slice(2);
  if (command === "list") console.table((await listRecentRuns(db.db)).map((r) => ({ id: r.id, repository: r.repositoryFullName, issue: r.issueNumber, mode: r.mode, status: r.status, reason: r.statusReason })));
  else {
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Usage: pnpm runs list | show RUN_ID | cancel RUN_ID | retry RUN_ID");
    if (command === "show") console.log(JSON.stringify(await getRunDetail(db.db, id), null, 2));
    else if (command === "cancel") console.log({ cancelled: await cancelRun(db.db, id) });
    else if (command === "retry") console.log({ requeued: await requestRunRecovery(db.db, id) });
    else throw new Error("Unknown command");
  }
} finally { await db.close(); }
