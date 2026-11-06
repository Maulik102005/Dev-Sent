import { createDatabase } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const connection = createDatabase(databaseUrl);

try {
  await migrateDatabase(connection.db);
  console.log("Database migrations completed.");
} finally {
  await connection.close();
}
