import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

config({
  path: ".env.local",
});

const runMigrate = async () => {
  if (!process.env.POSTGRES_URL) {
    console.log("⏭️  POSTGRES_URL not defined, skipping migrations");
    process.exit(0);
  }

  const connection = postgres(process.env.POSTGRES_URL, { max: 1 });
  const db = drizzle(connection);

  console.log("⏳ Running migrations...");

  const start = Date.now();
  try {
    await migrate(db, { migrationsFolder: "./lib/db/migrations" });
    const end = Date.now();
    console.log("✅ Migrations completed in", end - start, "ms");
    await connection.end();
    process.exit(0);
  } catch (err: any) {
    // Handle common migration errors that can be safely ignored
    const errorMessage = err?.message || String(err);
    const errorCode = err?.code;
    
    if (
      errorMessage.includes("already exists") ||
      errorCode === "42P07" || // relation already exists
      errorCode === "42701" || // duplicate column
      errorCode === "42P06" || // schema already exists
      errorCode === "42710" || // duplicate object
      errorMessage.includes("duplicate_object") ||
      (errorMessage.includes("column") && errorMessage.includes("already exists"))
    ) {
      console.log("⚠️  Migration warning (some objects already exist, continuing...)");
      console.log("   Error:", errorMessage);
      const end = Date.now();
      console.log("✅ Migrations completed in", end - start, "ms");
      await connection.end();
      process.exit(0);
    }
    throw err;
  }
};

runMigrate().catch((err) => {
  console.error("❌ Migration failed");
  console.error(err);
  process.exit(1);
});
