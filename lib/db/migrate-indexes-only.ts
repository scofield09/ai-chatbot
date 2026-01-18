import { config } from "dotenv";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";

config({
  path: ".env.local",
});

const runIndexMigration = async () => {
  if (!process.env.POSTGRES_URL) {
    console.log("⏭️  POSTGRES_URL not defined, skipping index migration");
    process.exit(0);
  }

  const sql = postgres(process.env.POSTGRES_URL, { max: 1 });

  console.log("⏳ Running vector index migration...");

  try {
    // Check if table exists
    const tableExists = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'DocumentEmbedding'
      );
    `;
    
    if (!tableExists[0]?.exists) {
      console.log("⚠️  DocumentEmbedding table does not exist. Please run db:migrate first.");
      await sql.end();
      process.exit(0);
    }

    // Check embedding column type
    const columnInfo = await sql`
      SELECT data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'DocumentEmbedding' 
      AND column_name = 'embedding';
    `;
    
    if (columnInfo.length === 0) {
      console.log("⚠️  embedding column does not exist in DocumentEmbedding table.");
      await sql.end();
      process.exit(0);
    }

    const embeddingType = columnInfo[0]?.data_type;
    console.log(`📋 Detected embedding column type: ${embeddingType}`);
    
    // Check if pgvector extension is installed
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector;`;
      console.log("✅ pgvector extension checked");
    } catch (error: any) {
      console.log("⚠️  Warning: Could not ensure pgvector extension:", error.message);
    }

    // Check row count (IVFFlat needs some data)
    const rowCount = await sql`SELECT COUNT(*) as count FROM "DocumentEmbedding";`;
    const count = Number(rowCount[0]?.count || 0);
    console.log(`📊 DocumentEmbedding table has ${count} rows`);
    
    // Calculate optimal lists parameter for IVFFlat (rows / 1000, minimum 10)
    // But for small datasets, use smaller lists to reduce memory requirements
    const optimalLists = Math.max(10, Math.min(100, Math.floor(count / 100) || 10));
    console.log(`📐 Optimal IVFFlat lists parameter: ${optimalLists} (based on ${count} rows)`);

    // Determine vector dimension from column type or use default
    let vectorDimension = 1024;
    if (embeddingType === "USER-DEFINED") {
      // Try to get dimension from the actual column definition
      const vectorDef = await sql`
        SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) as type
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
        WHERE c.relname = 'DocumentEmbedding' 
        AND a.attname = 'embedding';
      `;
      const typeStr = vectorDef[0]?.type || "";
      const match = typeStr.match(/vector\((\d+)\)/);
      if (match) {
        vectorDimension = Number(match[1]);
        console.log(`📐 Detected vector dimension: ${vectorDimension}`);
      }
    }

    // Read the migration file
    const migrationSQL = readFileSync(
      join(process.cwd(), "lib/db/migrations/0009_add_vector_indexes.sql"),
      "utf-8"
    );

    // Replace vector dimension and lists parameter in SQL
    let processedSQL = migrationSQL.replace(/vector\(1024\)/g, `vector(${vectorDimension})`);
    // Replace lists parameter with optimal value
    processedSQL = processedSQL.replace(/WITH \(lists = \d+\)/g, `WITH (lists = ${optimalLists})`);

    // Split by statement-breakpoint and extract CREATE INDEX statements
    const statements = processedSQL
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        // Extract only the CREATE INDEX statement, ignoring comments
        const lines = s.split("\n");
        const sqlLines: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          // Skip empty lines and comment-only lines
          if (trimmed.length === 0 || trimmed.startsWith("--")) {
            continue;
          }
          sqlLines.push(line);
        }
        return sqlLines.join("\n").trim();
      })
      .filter((s) => s.length > 0 && s.toUpperCase().includes("CREATE INDEX"));

    console.log(`\n🔨 Executing ${statements.length} index creation statements...\n`);

    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
        const indexName = statement.match(/CREATE INDEX.*?"?(\w+)"?/i)?.[1] || "index";
        console.log(`✅ Created index: ${indexName}`);
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const errorCode = error?.code;
        
        // Ignore "already exists" errors for indexes
        if (
          errorMessage.includes("already exists") ||
          errorCode === "42P07" || // relation already exists
          errorCode === "42710" || // duplicate object
          errorMessage.includes("duplicate")
        ) {
          const indexName = statement.match(/CREATE INDEX.*?"?(\w+)"?/i)?.[1] || "index";
          console.log(`⏭️  Index already exists: ${indexName}`);
          continue;
        }
        
        // Special handling for IVFFlat index on empty table
        if (errorMessage.includes("must have at least") || errorMessage.includes("rows")) {
          console.log(`⚠️  Cannot create IVFFlat index: table needs at least some rows`);
          console.log(`   Error: ${errorMessage}`);
          continue;
        }
        
        // Handle memory issues - try with smaller lists parameter
        if (errorMessage.includes("maintenance_work_mem") || errorMessage.includes("memory required")) {
          const indexName = statement.match(/CREATE INDEX.*?"?(\w+)"?/i)?.[1] || "index";
          if (indexName.includes("vector") && optimalLists > 10) {
            console.log(`⚠️  Memory issue creating vector index. Trying with smaller lists parameter...`);
            // Try with minimum lists (10)
            try {
              const smallerStatement = statement.replace(/WITH \(lists = \d+\)/g, "WITH (lists = 10)");
              await sql.unsafe(smallerStatement);
              console.log(`✅ Created vector index with lists=10 (minimum)`);
              continue;
            } catch (retryError: any) {
              console.log(`⚠️  Still failed with smaller lists. Skipping vector index for now.`);
              console.log(`   You can create it later when you have more data or increase maintenance_work_mem`);
              continue;
            }
          } else {
            console.log(`⚠️  Memory issue creating index: ${indexName}`);
            console.log(`   Error: ${errorMessage}`);
            continue;
          }
        }
        
        console.error(`❌ Failed to create index:`);
        console.error(`   Statement: ${statement.substring(0, 100)}...`);
        console.error(`   Error: ${errorMessage}`);
        throw error;
      }
    }

    console.log("\n✅ Vector index migration completed");
    
    // Verify indexes
    const indexes = await sql`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'DocumentEmbedding'
      ORDER BY indexname;
    `;
    
    console.log("\n📊 Current indexes on DocumentEmbedding:");
    if (indexes.length === 0) {
      console.log("   (no indexes found)");
    } else {
      for (const idx of indexes) {
        console.log(`   - ${idx.indexname}`);
      }
    }
    
    await sql.end();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Index migration failed");
    console.error(error);
    await sql.end();
    process.exit(1);
  }
};

runIndexMigration();
