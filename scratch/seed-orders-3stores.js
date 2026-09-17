const { query } = require('../src/db');

async function seedOrdersForStores() {
  const storesRes = await query('SELECT id, name, slug FROM stores ORDER BY id ASC');
  for (const st of storesRes.rows) {
    const tablesRes = await query('SELECT id FROM restaurant_tables WHERE store_id = $1 AND is_takeaway = FALSE LIMIT 3', [st.id]);
    const menusRes = await query('SELECT id, name, price FROM menus WHERE store_id = $1 LIMIT 4', [st.id]);
    
    if (tablesRes.rows.length === 0 || menusRes.rows.length === 0) continue;

    for (let i = 1; i <= 3; i++) {
      const table = tablesRes.rows[(i - 1) % tablesRes.rows.length];
      const menu = menusRes.rows[(i - 1) % menusRes.rows.length];
      const qty = 2;
      const subtotal = parseFloat(menu.price) * qty;
      const net = subtotal;
      const orderNum = 'ORD-' + st.slug.substring(0, 4).toUpperCase() + '-' + (1000 + i);

      const orderRes = await query(`
        INSERT INTO orders (
          order_number, store_id, table_id, customer_name, customer_count,
          status, subtotal_amount, discount_amount, service_amount, vat_amount,
          net_amount, payment_status, opened_at, closed_at
        ) VALUES (
          $1, $2, $3, $4, $5, 'completed', $6, 0, 0, 0, $7, 'paid', NOW() - INTERVAL '${i} days', NOW() - INTERVAL '${i} days'
        ) RETURNING id
      `, [orderNum, st.id, table.id, `ลูกค้าตัวอย่าง ${i}`, 2, subtotal, net]);

      const orderId = orderRes.rows[0].id;

      await query(`
        INSERT INTO order_items (
          order_id, menu_id, menu_name, unit_price, quantity, options_price, total_price, status
        ) VALUES (
          $1, $2, $3, $4, $5, 0, $6, 'served'
        )
      `, [orderId, menu.id, menu.name, menu.price, qty, subtotal]);
    }
  }
  console.log('[Seed Orders] Sample orders added successfully!');
}

seedOrdersForStores()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
