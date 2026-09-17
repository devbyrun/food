const { query } = require('./src/db');

async function seedOrders() {
  const stores = await query('SELECT id, slug FROM stores LIMIT 3');
  if (stores.rows.length === 0) return;

  const tables = await query('SELECT id, store_id FROM restaurant_tables LIMIT 5');
  if (tables.rows.length === 0) return;

  console.log('Generating sample realistic sales data for analytics...');
  
  const dates = [
    { date: new Date(), amount: 450, method: 'promptpay' },
    { date: new Date(Date.now() - 86400000), amount: 890, method: 'cash' },
    { date: new Date(Date.now() - 86400000 * 2), amount: 1250, method: 'promptpay' },
    { date: new Date(Date.now() - 86400000 * 4), amount: 620, method: 'cash' },
    { date: new Date(Date.now() - 86400000 * 8), amount: 2100, method: 'promptpay' },
    { date: new Date(Date.now() - 86400000 * 15), amount: 1750, method: 'cash' },
    { date: new Date(Date.now() - 86400000 * 45), amount: 3400, method: 'promptpay' },
    { date: new Date(Date.now() - 86400000 * 75), amount: 4800, method: 'promptpay' }
  ];

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const store = stores.rows[i % stores.rows.length];
    const table = tables.rows[i % tables.rows.length];
    const orderNum = 'ORD-SEED-' + Math.floor(10000 + Math.random() * 90000);

    const ord = await query(
      `INSERT INTO orders (
        order_number, store_id, table_id, customer_name, status,
        subtotal_amount, net_amount, payment_status, opened_at, closed_at
      ) VALUES ($1, $2, $3, $4, 'completed', $5, $5, 'paid', $6, $6)
      RETURNING id`,
      [orderNum, store.id, table.id, 'ลูกค้าทั่วไป', d.amount, d.date]
    );

    await query(
      `INSERT INTO payments (order_id, store_id, payment_method, amount_received, paid_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [ord.rows[0].id, store.id, d.method, d.amount, d.date]
    );
  }

  console.log('Sample sales data created successfully!');
  process.exit(0);
}

seedOrders().catch(e => { console.error(e); process.exit(1); });
