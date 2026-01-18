import { config } from "dotenv";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";

config({
  path: ".env.local",
});

const runManualMigrate = async () => {
  if (!process.env.POSTGRES_URL) {
    console.log("⏭️  POSTGRES_URL not defined, skipping migrations");
    process.exit(0);
  }

  const sql = postgres(process.env.POSTGRES_URL, { max: 1 });

  console.log("⏳ Running manual RAG migration...");

  try {
    // Read the migration file
    const migrationSQL = readFileSync(
      join(process.cwd(), "lib/db/migrations/0008_public_wild_pack.sql"),
      "utf-8"
    );

    // Split by statement-breakpoint and execute each statement
    const statements = migrationSQL
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
        console.log("✅ Executed:", statement.substring(0, 50) + "...");
      } catch (error: any) {
        // Ignore "already exists" errors and foreign key constraint errors
        if (
          error.message?.includes("already exists") ||
          error.code === "42P07" || // relation already exists
          error.code === "42701" || // duplicate column
          error.code === "42P06" || // schema already exists
          error.code === "42830" || // no unique constraint (foreign key issue)
          error.code === "42710" || // extension already exists
          error.message?.includes("duplicate_object") ||
          error.message?.includes("no unique constraint")
        ) {
          console.log("⏭️  Skipped:", error.code || error.message?.substring(0, 50));
          continue;
        }
        // For foreign key errors, log but continue
        if (error.code === "42830") {
          console.log("⚠️  Foreign key constraint skipped (Document uses composite key):", statement.substring(0, 50) + "...");
          continue;
        }
        throw error;
      }
    }

    console.log("✅ Manual migration completed");
    process.exit(0);
  } catch (error) {
    console.error("❌ Manual migration failed");
    console.error(error);
    process.exit(1);
  } finally {
    await sql.end();
  }
};

runManualMigrate();

