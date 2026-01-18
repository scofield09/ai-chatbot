import { config } from "dotenv";
import postgres from "postgres";

config({
  path: ".env.local",
});

const createVectorIndex = async () => {
  if (!process.env.POSTGRES_URL) {
    console.log("⏭️  POSTGRES_URL not defined");
    process.exit(0);
  }

  const sql = postgres(process.env.POSTGRES_URL, { max: 1 });

  try {
    console.log("⏳ Creating vector index with minimal memory requirements...");

    // Try to temporarily increase maintenance_work_mem (may not work on managed databases)
    try {
      await sql`SET maintenance_work_mem = '64MB';`;
      console.log("✅ Increased maintenance_work_mem to 64MB");
    } catch (error: any) {
      console.log("⚠️  Could not increase maintenance_work_mem (may require superuser):", error.message);
    }

    // Get row count
    const rowCount = await sql`SELECT COUNT(*) as count FROM "DocumentEmbedding";`;
    const count = Number(rowCount[0]?.count || 0);
    console.log(`📊 DocumentEmbedding table has ${count} rows`);

    // Check if index already exists
    const existingIndex = await sql`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'DocumentEmbedding' 
      AND indexname = 'document_embedding_vector_idx';
    `;

    if (existingIndex.length > 0) {
      console.log("✅ Vector index already exists!");
      await sql.end();
      process.exit(0);
    }

    // Determine vector dimension
    const vectorDef = await sql`
      SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) as type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
      WHERE c.relname = 'DocumentEmbedding' 
      AND a.attname = 'embedding';
    `;
    const typeStr = vectorDef[0]?.type || "";
    const match = typeStr.match(/vector\((\d+)\)/);
    const vectorDimension = match ? Number(match[1]) : 1024;
    console.log(`📐 Vector dimension: ${vectorDimension}`);

    // Use minimum lists parameter (10) to reduce memory requirements
    const lists = Math.max(10, Math.floor(count / 100) || 10);
    console.log(`📐 Using lists parameter: ${lists}`);

    // Create index with minimal parameters
    console.log("\n🔨 Creating vector index...");
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "document_embedding_vector_idx" 
      ON "DocumentEmbedding" 
      USING ivfflat ((embedding::vector(${vectorDimension})) vector_cosine_ops)
      WITH (lists = ${lists});
    `);

    console.log("✅ Vector index created successfully!");

    // Verify
    const indexes = await sql`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'DocumentEmbedding'
      AND indexname = 'document_embedding_vector_idx';
    `;

    if (indexes.length > 0) {
      console.log("\n📊 Vector index details:");
      console.log(`   Name: ${indexes[0].indexname}`);
      console.log(`   Definition: ${indexes[0].indexdef.substring(0, 100)}...`);
    }

    await sql.end();
    process.exit(0);
  } catch (error: any) {
    console.error("\n❌ Failed to create vector index");
    console.error("Error:", error.message);
    
    if (error.message.includes("maintenance_work_mem")) {
      console.log("\n💡 Suggestions:");
      console.log("   1. Contact your database administrator to increase maintenance_work_mem");
      console.log("   2. Or wait until you have more data (IVFFlat works better with more data)");
      console.log("   3. Or use a database with higher memory limits");
    }
    
    await sql.end();
    process.exit(1);
  }
};

createVectorIndex();
