const { query } = require('../src/db');

async function migrateTakeaway() {
  console.log('--- Migrating Takeaway Tables for All Stores ---');
  
  // 1. Ensure column exists
  await query(`ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS is_takeaway BOOLEAN DEFAULT FALSE;`);

  // 2. Fetch all stores
  const storesRes = await query(`SELECT id, slug, name FROM stores ORDER BY id ASC`);
  console.log(`Found ${storesRes.rows.length} stores.`);

  for (const store of storesRes.rows) {
    const existing = await query(
      `SELECT id, table_number, is_takeaway FROM restaurant_tables WHERE store_id = $1 AND (is_takeaway = TRUE OR table_number = 'กลับบ้าน') LIMIT 1`,
      [store.id]
    );

    if (existing.rows.length === 0) {
      const qrToken = `${store.slug}-takeaway-${Math.random().toString(36).substring(2, 7)}`;
      await query(
        `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
         VALUES ($1, NULL, 'กลับบ้าน', 0, $2, 'available', TRUE)
         ON CONFLICT (store_id, table_number) DO UPDATE SET is_takeaway = TRUE, is_active = TRUE`,
        [store.id, qrToken]
      );
      console.log(`[Store ${store.id} - ${store.slug}] Created Takeaway table.`);
    } else {
      if (!existing.rows[0].is_takeaway) {
        await query(`UPDATE restaurant_tables SET is_takeaway = TRUE WHERE id = $1`, [existing.rows[0].id]);
        console.log(`[Store ${store.id} - ${store.slug}] Updated existing table '${existing.rows[0].table_number}' to is_takeaway = true.`);
      } else {
        console.log(`[Store ${store.id} - ${store.slug}] Takeaway table already exists.`);
      }
    }
  }

  console.log('--- Takeaway Migration Complete ---');
}

migrateTakeaway().then(() => process.exit(0)).catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
