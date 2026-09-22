const { query, getClient } = require('../db');
const { broadcastToStore, broadcastToOrder } = require('../services/websocket');
const { sendKitchenOrderNotification } = require('../services/telegram');

async function getTableAndMenu(req, res) {
  try {
    const { storeSlug, qrToken } = req.params;

    // 1. Get Store
    const storeRes = await query(`SELECT * FROM stores WHERE slug = $1 AND status = 'active'`, [storeSlug]);
    if (storeRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลร้านค้านี้ในระบบ' });
    }
    const store = storeRes.rows[0];

    // 2. Get Table
    const tableRes = await query(
      `SELECT t.*, z.name as zone_name
       FROM restaurant_tables t
       LEFT JOIN table_zones z ON t.zone_id = z.id
       WHERE t.store_id = $1 AND t.qr_token = $2 AND t.is_active = TRUE`,
      [store.id, qrToken]
    );

    if (tableRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลโต๊ะอาหาร หรือ QR Code ไม่ถูกต้อง' });
    }
    const table = tableRes.rows[0];

    // 3. Get Categories
    const catRes = await query(
      `SELECT * FROM categories WHERE store_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, id ASC`,
      [store.id]
    );

    // 4. Get Menus with Option Groups
    const menuRes = await query(
      `SELECT m.*, c.name as category_name
       FROM menus m
       JOIN categories c ON m.category_id = c.id
       WHERE m.store_id = $1 AND m.is_available = TRUE AND c.is_active = TRUE
       ORDER BY m.is_recommend DESC, m.sort_order ASC, m.id ASC`,
      [store.id]
    );

    // 5. Get Option Groups and Items
    const optGroupRes = await query(
      `SELECT mog.menu_id, og.id as group_id, og.name as group_name, og.is_required, og.min_select, og.max_select,
              oi.id as item_id, oi.name as item_name, oi.extra_price, oi.is_available as item_available
       FROM menu_option_groups mog
       JOIN option_groups og ON mog.group_id = og.id
       JOIN option_items oi ON og.id = oi.group_id
       WHERE og.store_id = $1 AND oi.is_available = TRUE
       ORDER BY og.id ASC, oi.sort_order ASC`,
      [store.id]
    );

    // Map options to menus
    const menuMap = {};
    for (const m of menuRes.rows) {
      menuMap[m.id] = { ...m, option_groups: [] };
    }

    const groupMap = {};
    for (const row of optGroupRes.rows) {
      const menu = menuMap[row.menu_id];
      if (!menu) continue;

      const groupKey = `${row.menu_id}_${row.group_id}`;
      if (!groupMap[groupKey]) {
        groupMap[groupKey] = {
          id: row.group_id,
          name: row.group_name,
          is_required: row.is_required,
          min_select: row.min_select,
          max_select: row.max_select,
          items: [],
        };
        menu.option_groups.push(groupMap[groupKey]);
      }

      groupMap[groupKey].items.push({
        id: row.item_id,
        name: row.item_name,
        extra_price: parseFloat(row.extra_price || 0),
      });
    }

    // 6. Get Current Active Order for this Table (if any)
    let activeOrder = null;
    const orderRes = await query(
      `SELECT * FROM orders WHERE table_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
      [table.id]
    );

    if (orderRes.rows.length > 0) {
      activeOrder = orderRes.rows[0];
      const itemsRes = await query(
        `SELECT oi.*, 
                COALESCE(json_agg(json_build_object('id', oio.id, 'name', oio.option_name, 'extra_price', oio.extra_price)) 
                         FILTER (WHERE oio.id IS NOT NULL), '[]') as options
         FROM order_items oi
         LEFT JOIN order_item_options oio ON oi.id = oio.order_item_id
         WHERE oi.order_id = $1
         GROUP BY oi.id
         ORDER BY oi.id ASC`,
        [activeOrder.id]
      );
      activeOrder.items = itemsRes.rows;
    }

    return res.json({
      success: true,
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        logo_url: store.logo_url,
        banner_url: store.banner_url,
        address: store.address,
        phone_number: store.phone_number,
        promptpay_number: store.promptpay_number,
        promptpay_name: store.promptpay_name,
        promptpay_qr_url: store.promptpay_qr_url,
        vat_rate: parseFloat(store.vat_rate || 0),
        service_charge: parseFloat(store.service_charge || 0),
        is_open: store.is_open,
      },
      table: {
        id: table.id,
        table_number: table.table_number,
        seat_capacity: table.seat_capacity,
        zone_name: table.zone_name,
        status: table.status,
        is_takeaway: Boolean(table.is_takeaway || table.table_number === 'กลับบ้าน' || table.table_number === 'สั่งกลับบ้าน'),
      },
      categories: catRes.rows,
      menus: Object.values(menuMap),
      activeOrder,
    });
  } catch (err) {
    console.error('[Customer getTableAndMenu Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูล' });
  }
}

async function submitOrder(req, res) {
  const client = await getClient();
  try {
    const { storeSlug, qrToken } = req.params;
    const { items, customer_name, customer_count } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่มีรายการอาหารในคำสั่งซื้อ' });
    }

    await client.query('BEGIN');

    // 1. Get Store and Table
    const storeRes = await client.query(`SELECT * FROM stores WHERE slug = $1 AND status = 'active'`, [storeSlug]);
    if (storeRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบร้านค้า' });
    }
    const store = storeRes.rows[0];

    if (store.is_open === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'ขณะนี้ร้านค้าปิดรับออเดอร์ชั่วคราว กรุณาติดต่อพนักงาน' });
    }

    const tableRes = await client.query(
      `SELECT * FROM restaurant_tables WHERE store_id = $1 AND qr_token = $2 AND is_active = TRUE`,
      [store.id, qrToken]
    );
    if (tableRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบโต๊ะอาหาร' });
    }
    const table = tableRes.rows[0];
    const isTakeaway = Boolean(table.is_takeaway || table.table_number === 'กลับบ้าน' || table.table_number === 'สั่งกลับบ้าน');

    // 2. Find or Create Active Order
    let order = null;
    const existingOrderRes = await client.query(
      `SELECT * FROM orders WHERE table_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [table.id]
    );

    if (existingOrderRes.rows.length > 0) {
      order = existingOrderRes.rows[0];
    } else {
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const cleanTableTag = isTakeaway ? 'TAKEAWAY' : (table.table_number.replace(/[^a-zA-Z0-9]/g, '') || 'TBL');
      const orderNumber = `ORD-${todayStr}-${cleanTableTag}-${randomSuffix}`;
      const defaultCustName = isTakeaway ? 'ลูกค้าสั่งกลับบ้าน (Takeaway)' : 'ลูกค้าโต๊ะ ' + table.table_number;

      const newOrderRes = await client.query(
        `INSERT INTO orders (order_number, store_id, table_id, customer_name, customer_count, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', 'customer_qr') RETURNING *`,
        [orderNumber, store.id, table.id, customer_name || defaultCustName, customer_count || 1]
      );
      order = newOrderRes.rows[0];
    }

    // 3. Process and Insert Order Items
    let newItemsTotal = 0;
    const insertedItems = [];

    for (const item of items) {
      const menuRes = await client.query(`SELECT * FROM menus WHERE id = $1 AND store_id = $2`, [item.menu_id, store.id]);
      if (menuRes.rows.length === 0) continue;
      const menu = menuRes.rows[0];

      const unitPrice = parseFloat(menu.special_price || menu.price);
      let optionsPrice = 0;

      if (item.options && Array.isArray(item.options)) {
        for (const opt of item.options) {
          optionsPrice += parseFloat(opt.extra_price || 0);
        }
      }

      const qty = parseInt(item.quantity, 10) || 1;
      const totalPrice = (unitPrice + optionsPrice) * qty;
      newItemsTotal += totalPrice;

      const orderItemRes = await client.query(
        `INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, quantity, options_price, total_price, special_notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
        [order.id, menu.id, menu.name, unitPrice, qty, optionsPrice, totalPrice, item.special_notes || '']
      );
      const insertedItem = orderItemRes.rows[0];
      insertedItem.options = [];

      if (item.options && Array.isArray(item.options)) {
        for (const opt of item.options) {
          await client.query(
            `INSERT INTO order_item_options (order_item_id, option_name, extra_price) VALUES ($1, $2, $3)`,
            [insertedItem.id, opt.name, parseFloat(opt.extra_price || 0)]
          );
          insertedItem.options.push(opt);
        }
      }

      insertedItems.push(insertedItem);
    }

    // 4. Update Order Total (Direct net amount without service charge or VAT)
    const allItemsRes = await client.query(
      `SELECT SUM(total_price) as subtotal FROM order_items WHERE order_id = $1 AND status != 'cancelled'`,
      [order.id]
    );
    const subtotal = parseFloat(allItemsRes.rows[0].subtotal || 0);
    const serviceAmount = 0;
    const vatAmount = 0;
    const netAmount = subtotal;

    await client.query(
      `UPDATE orders SET
        subtotal_amount = $1,
        service_amount = $2,
        vat_amount = $3,
        net_amount = $4,
        status = 'active'
       WHERE id = $5`,
      [subtotal, serviceAmount, vatAmount, netAmount, order.id]
    );

    // 5. Update Table Status to occupied
    await client.query(
      `UPDATE restaurant_tables SET status = 'occupied', current_order_id = $1 WHERE id = $2`,
      [order.id, table.id]
    );

    await client.query('COMMIT');

    // 6. Asynchronously trigger Telegram Notifications & Realtime WebSockets
    setImmediate(async () => {
      try {
        await sendKitchenOrderNotification(store, order, insertedItems, table);
      } catch (err) {
        console.error('[Telegram Notification Error]:', err.message);
      }

      // Broadcast to Store Dashboard, KDS, Floor Map
      const totalItemCount = insertedItems.reduce((sum, item) => sum + (parseInt(item.quantity, 10) || 1), 0);
      const isTakeawayOrder = Boolean(isTakeaway || table.is_takeaway || table.table_number === 'กลับบ้าน' || table.table_number === 'สั่งกลับบ้าน' || table.table_number === 'TAKEAWAY');
      
      broadcastToStore(store.id, 'order_created', {
        orderId: order.id,
        orderNumber: order.order_number,
        tableId: table.id,
        tableNumber: table.table_number,
        isTakeaway: isTakeawayOrder,
        customerName: order.customer_name || (isTakeawayOrder ? 'สั่งกลับบ้าน' : `โต๊ะ ${table.table_number}`),
        items: insertedItems,
        itemCount: totalItemCount,
        subtotal,
        netAmount,
        createdAt: new Date().toISOString(),
      });

      broadcastToOrder(order.id, 'order_updated', {
        orderId: order.id,
        items: insertedItems,
        subtotal,
        netAmount,
      });
    });

    return res.json({
      success: true,
      message: 'ส่งรายการอาหารเข้าครัวเรียบร้อยแล้ว!',
      orderId: order.id,
      orderNumber: order.order_number,
      items: insertedItems,
      subtotal,
      netAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Customer submitOrder Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสั่งอาหาร' });
  } finally {
    client.release();
  }
}

async function getOrderStatus(req, res) {
  try {
    const { orderId } = req.params;
    const orderRes = await query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลออเดอร์' });
    }
    const order = orderRes.rows[0];

    const storeRes = await query(`SELECT * FROM stores WHERE id = $1`, [order.store_id]);
    const tableRes = await query(`SELECT * FROM restaurant_tables WHERE id = $1`, [order.table_id]);

    const itemsRes = await query(
      `SELECT oi.*, 
              COALESCE(json_agg(json_build_object('id', oio.id, 'name', oio.option_name, 'extra_price', oio.extra_price)) 
                       FILTER (WHERE oio.id IS NOT NULL), '[]') as options
       FROM order_items oi
       LEFT JOIN order_item_options oio ON oi.id = oio.order_item_id
       WHERE oi.order_id = $1
       GROUP BY oi.id
       ORDER BY oi.id ASC`,
      [order.id]
    );

    return res.json({
      success: true,
      order: {
        ...order,
        store: storeRes.rows[0],
        table: tableRes.rows[0],
        items: itemsRes.rows,
      },
    });
  } catch (err) {
    console.error('[Customer getOrderStatus Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function callService(req, res) {
  try {
    const { storeSlug, qrToken } = req.params;
    const { call_type, note } = req.body;

    const storeRes = await query(`SELECT * FROM stores WHERE slug = $1`, [storeSlug]);
    if (storeRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบร้านค้า' });
    }
    const store = storeRes.rows[0];

    const tableRes = await query(
      `SELECT * FROM restaurant_tables WHERE store_id = $1 AND qr_token = $2`,
      [store.id, qrToken]
    );
    if (tableRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบโต๊ะอาหาร' });
    }
    const table = tableRes.rows[0];

    // Insert Service Call
    const callRes = await query(
      `INSERT INTO service_calls (store_id, table_id, call_type, note, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [store.id, table.id, call_type || 'call_staff', note || '']
    );

    // If check_bill, update table status
    if (call_type === 'check_bill') {
      await query(`UPDATE restaurant_tables SET status = 'bill_requested' WHERE id = $1`, [table.id]);
    }

    // Broadcast Real-time
    broadcastToStore(store.id, 'service_call', {
      call: callRes.rows[0],
      tableNumber: table.table_number,
      callType: call_type,
      note,
    });

    return res.json({
      success: true,
      message: call_type === 'check_bill' ? 'ส่งคำขอเช็คบิลไปยังพนักงานแล้ว' : 'เรียกพนักงานเรียบร้อยแล้ว พนักงานกำลังมาบริการครับ',
      call: callRes.rows[0],
    });
  } catch (err) {
    console.error('[Customer callService Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเรียกพนักงาน' });
  }
}

module.exports = {
  getTableAndMenu,
  submitOrder,
  getOrderStatus,
  callService,
};
