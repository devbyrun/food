const { query } = require('../src/db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_12345';

async function runTests() {
  console.log('=== RUNNING TAKEAWAY TESTS ===');

  // 1. Get store 1 manager
  const userRes = await query(`SELECT * FROM users WHERE username = 'manager' LIMIT 1`);
  if (userRes.rows.length === 0) throw new Error('User manager not found');
  const user = userRes.rows[0];

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, store_id: 1 },
    JWT_SECRET,
    { expiresIn: '1d' }
  );

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Fetch admin tables
  const resTables = await fetch('http://localhost:3000/api/admin/tables', { headers });
  const dataTables = await resTables.json();
  console.log('1. Admin tables count:', dataTables.tables.length);
  const takeawayTable = dataTables.tables.find(t => t.is_takeaway || t.table_number === 'กลับบ้าน');
  console.log('Takeaway table found:', takeawayTable ? {
    id: takeawayTable.id,
    table_number: takeawayTable.table_number,
    is_takeaway: takeawayTable.is_takeaway,
    qr_token: takeawayTable.qr_token,
    orderUrl: takeawayTable.orderUrl
  } : 'NOT FOUND');

  if (!takeawayTable) throw new Error('Takeaway table not found in admin tables');

  // 2. Try to delete takeaway table (should be rejected)
  const resDelete = await fetch(`http://localhost:3000/api/admin/tables/${takeawayTable.id}`, {
    method: 'DELETE',
    headers
  });
  const dataDelete = await resDelete.json();
  console.log('2. Delete takeaway table response:', dataDelete);
  if (dataDelete.success !== false) throw new Error('Expected deletion to fail!');

  // 3. Customer view on takeaway QR
  const resCust = await fetch(`http://localhost:3000/api/customer/store/somtum-zaab/table/${takeawayTable.qr_token}`);
  const dataCust = await resCust.json();
  console.log('3. Customer getTableAndMenu table:', dataCust.table);
  if (!dataCust.table || !dataCust.table.is_takeaway) throw new Error('Expected table.is_takeaway to be true in customer API');

  // 4. Submit order through takeaway QR
  const menus = dataCust.menus;
  if (!menus || menus.length === 0) throw new Error('No menus found');
  const sampleMenu = menus[0];

  const resOrder = await fetch(`http://localhost:3000/api/customer/store/somtum-zaab/table/${takeawayTable.qr_token}/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        {
          menu_id: sampleMenu.id,
          name: sampleMenu.name,
          quantity: 2,
          price: sampleMenu.price,
          options: [],
          special_notes: 'ใส่ถุงกลับบ้านแยกน้ำ'
        }
      ]
    })
  });
  const dataOrder = await resOrder.json();
  console.log('4. Submit takeaway order result:', dataOrder);
  if (!dataOrder.success) throw new Error('Failed to submit order');

  // 5. Kitchen orders
  const resKitchen = await fetch('http://localhost:3000/api/admin/kitchen/orders', { headers });
  const dataKitchen = await resKitchen.json();
  const kItem = dataKitchen.items.find(it => it.order_id == dataOrder.orderId);
  console.log('5. Kitchen item found:', kItem ? {
    id: kItem.id,
    order_number: kItem.order_number,
    table_number: kItem.table_number,
    is_takeaway: kItem.is_takeaway,
    special_notes: kItem.special_notes
  } : 'NOT FOUND');

  // 6. POS table bill
  const resBill = await fetch(`http://localhost:3000/api/admin/pos/table/${takeawayTable.id}`, { headers });
  const dataBill = await resBill.json();
  console.log('6. POS Table bill order_number:', dataBill.order?.order_number, 'net_amount:', dataBill.order?.net_amount);

  // 7. POS Checkout
  const resCheckout = await fetch(`http://localhost:3000/api/admin/pos/order/${dataOrder.orderId}/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      payment_method: 'promptpay',
      received_amount: dataBill.order?.net_amount
    })
  });
  const dataCheckout = await resCheckout.json();
  console.log('7. POS Checkout result:', dataCheckout.success, dataCheckout.message);

  console.log('=== ALL TAKEAWAY TESTS PASSED! ===');
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error('Test Error:', err);
  process.exit(1);
});
