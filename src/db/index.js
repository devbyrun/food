const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const isCloudDb = Boolean(
  process.env.DATABASE_URL && (
    process.env.DATABASE_URL.includes('sslmode=require') ||
    process.env.DATABASE_URL.includes('neon.tech') ||
    process.env.DATABASE_URL.includes('supabase.co') ||
    process.env.DATABASE_URL.includes('render.com') ||
    process.env.DATABASE_URL.includes('aws.com') ||
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL === '1'
  )
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isCloudDb ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[Database Pool Error]:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.DEBUG_SQL === 'true') {
      console.log(`[SQL Query] (${duration}ms):`, text, params);
    }
    return res;
  } catch (err) {
    console.error('[SQL Query Error]:', err.message, '\nQuery:', text, '\nParams:', params);
    throw err;
  }
}

async function getClient() {
  return await pool.connect();
}

async function initDatabase() {
  console.log('[Database] Connecting to PostgreSQL (Neon)...');
  try {
    const client = await pool.connect();
    console.log('[Database] Connected successfully!');
    
    // Read and run schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await client.query(schemaSql);
      console.log('[Database] Schema migrations applied successfully.');
    }
    
    client.release();
    return true;
  } catch (err) {
    console.error('[Database Init Error]:', err.message);
    throw err;
  }
}

module.exports = {
  pool,
  query,
  getClient,
  initDatabase,
};
