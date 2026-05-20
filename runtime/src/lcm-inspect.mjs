import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [outputPath] = process.argv.slice(2);

const lcmRoot = process.env.BEEP_LCM_ROOT || "/opt/lossless-claw";
const dbPath = process.env.BEEP_LCM_DB || join(process.env.BEEP_LCM_DIR || "/lcm", "beep-lcm.sqlite");

function moduleUrl(relativePath) {
  return pathToFileURL(join(lcmRoot, relativePath)).href;
}

const [{ createLcmDatabaseConnection, closeLcmConnection }, { runLcmMigrations }] = await Promise.all([
  import(moduleUrl("src/db/connection.ts")),
  import(moduleUrl("src/db/migration.ts")),
]);

const summary = {
  ok: false,
  dbPath,
  exists: existsSync(dbPath),
  rowCounts: {},
  conversations: [],
};

if (summary.exists) {
  const db = createLcmDatabaseConnection(dbPath);
  try {
    runLcmMigrations(db, { log: { info: () => {} } });
    summary.rowCounts = Object.fromEntries(
      ["conversations", "messages", "message_parts", "summaries"].map((table) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
        return [table, Number(row?.count ?? 0)];
      }),
    );
    summary.conversations = db
      .prepare(
        `SELECT conversation_id AS conversationId,
                session_id AS sessionId,
                session_key AS sessionKey,
                title,
                active,
                created_at AS createdAt,
                updated_at AS updatedAt
         FROM conversations
         ORDER BY conversation_id DESC
         LIMIT 10`,
      )
      .all();
    summary.ok = true;
  } finally {
    closeLcmConnection(db);
  }
}

const text = `${JSON.stringify(summary, null, 2)}\n`;
if (outputPath) {
  writeFileSync(outputPath, text);
}
console.log(text.trimEnd());
