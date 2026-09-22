const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const { query, getClient } = require('../db');
const { broadcastToStore, broadcastToOrder } = require('../services/websocket');
const { sendServiceReadyNotification, sendTelegramMessage, getSimulatedMessages, clearSimulatedMessages, handleTelegramWebhook } = require('../services/telegram');

// Helper to get active store_id for current user
function getStoreId(req) {
  if (req.query && req.query.store_id) {
    if (!req.user || req.user.role === 'admin' || !req.user.store_id) {
      return parseInt(req.query.store_id, 10);
    }
  }
  if (req.user && req.user.store_id) {
    return req.user.store_id;
  }
  if (req.query && req.query.store_id) {
    return parseInt(req.query.store_id, 10);
  }
  return 1; // Default
}

// -------------------------------------------------------------
// 1. Dashboard Metrics
// -------------------------------------------------------------
async function getDashboardMetrics(req, res) {
  try {
    const storeId = getStoreId(req);

    const storeRes = await query(`SELECT id, slug, name, trial_ends_at, plan_name, status, is_open, logo_url FROM stores WHERE id = $1`, [storeId]);
    const store = storeRes.rows[0] || { id: storeId, name: 'ร้านอาหาร', slug: 'store', trial_ends_at: null, is_open: true };

    // Sales Today
    const todaySalesRes = await query(
      `SELECT COALESCE(SUM(net_amount), 0) as total_sales, COUNT(id) as total_orders
       FROM orders
       WHERE store_id = $1 AND payment_status = 'paid'
         AND closed_at >= CURRENT_DATE`,
      [storeId]
    );

    // Active Tables
    const tableStatsRes = await query(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'available') as available_tables,
         COUNT(*) FILTER (WHERE status = 'occupied') as occupied_tables,
         COUNT(*) FILTER (WHERE status = 'bill_requested') as bill_requested_tables,
         COUNT(*) as total_tables
       FROM restaurant_tables
       WHERE store_id = $1 AND is_active = TRUE`,
      [storeId]
    );

    // Kitchen Status Counts
    const kitchenStatsRes = await query(
      `SELECT 
         COUNT(*) FILTER (WHERE oi.status = 'pending') as pending_dishes,
         COUNT(*) FILTER (WHERE oi.status = 'cooking') as cooking_dishes,
         COUNT(*) FILTER (WHERE oi.status = 'ready') as ready_dishes
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.store_id = $1 AND o.status = 'active'`,
      [storeId]
    );

    // Recent Active Orders
    const recentOrdersRes = await query(
      `SELECT o.*, t.table_number,
              (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o
       JOIN restaurant_tables t ON o.table_id = t.id
       WHERE o.store_id = $1 AND o.status = 'active'
       ORDER BY o.opened_at DESC LIMIT 5`,
      [storeId]
    );

    return res.json({
      success: true,
      store,
      metrics: {
        todaySales: parseFloat(todaySalesRes.rows[0].total_sales || 0),
        todayOrders: parseInt(todaySalesRes.rows[0].total_orders || 0, 10),
        tables: tableStatsRes.rows[0],
        kitchen: kitchenStatsRes.rows[0],
      },
      recentOrders: recentOrdersRes.rows,
    });
  } catch (err) {
    console.error('[Admin getDashboardMetrics Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดสถิติ' });
  }
}

// -------------------------------------------------------------
// 2. Table & Zone Management + QR Generator
// -------------------------------------------------------------
async function getTables(req, res) {
  try {
    const storeId = getStoreId(req);
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol;

    const storeRes = await query(`SELECT id, slug, name, trial_ends_at, plan_name, status, is_open, logo_url FROM stores WHERE id = $1`, [storeId]);
    const storeSlug = storeRes.rows[0]?.slug || 'store';
    const storeName = storeRes.rows[0]?.name || 'ร้านอาหาร';

    // Auto-ensure takeaway table exists for this store
    const takeawayCheck = await query(
      `SELECT id, is_takeaway FROM restaurant_tables WHERE store_id = $1 AND (is_takeaway = TRUE OR table_number = 'กลับบ้าน') LIMIT 1`,
      [storeId]
    );
    if (takeawayCheck.rows.length === 0) {
      const qrTokenTakeaway = `${storeSlug}-takeaway-${Math.random().toString(36).substring(2, 7)}`;
      await query(
        `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
         VALUES ($1, NULL, 'กลับบ้าน', 0, $2, 'available', TRUE)
         ON CONFLICT (store_id, table_number) DO UPDATE SET is_takeaway = TRUE, is_active = TRUE`,
        [storeId, qrTokenTakeaway]
      );
    } else if (!takeawayCheck.rows[0].is_takeaway) {
      await query(`UPDATE restaurant_tables SET is_takeaway = TRUE WHERE id = $1`, [takeawayCheck.rows[0].id]);
    }

    const zonesRes = await query(
      `SELECT * FROM table_zones WHERE store_id = $1 ORDER BY sort_order ASC, id ASC`,
      [storeId]
    );

    const tablesRes = await query(
      `SELECT t.*, z.name as zone_name,
              o.order_number, o.net_amount as current_bill_amount, o.opened_at as order_opened_at,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'served' AND oi.status != 'cancelled') as pending_item_count
       FROM restaurant_tables t
       LEFT JOIN table_zones z ON t.zone_id = z.id
       LEFT JOIN orders o ON t.current_order_id = o.id AND o.status = 'active'
       WHERE t.store_id = $1 AND t.is_active = TRUE
       ORDER BY t.is_takeaway DESC, t.zone_id ASC, t.table_number ASC`,
      [storeId]
    );

    // Generate QR Code data URLs for each table
    const tablesWithQR = await Promise.all(
      tablesRes.rows.map(async (table) => {
        const orderUrl = `${protocol}://${host}/order/${storeSlug}/${table.qr_token}`;
        const qrDataUrl = await QRCode.toDataURL(orderUrl, {
          width: 300,
          margin: 2,
          color: { dark: '#0f172a', light: '#ffffff' },
        });
        return {
          ...table,
          orderUrl,
          qrDataUrl,
          storeName,
          storeSlug,
        };
      })
    );

    return res.json({
      success: true,
      store: storeRes.rows[0],
      zones: zonesRes.rows,
      tables: tablesWithQR,
    });
  } catch (err) {
    console.error('[Admin getTables Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลโต๊ะ' });
  }
}

async function createTable(req, res) {
  try {
    const storeId = getStoreId(req);
    const { table_number, zone_id, zone_name, seat_capacity } = req.body;

    if (!table_number) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุหมายเลขโต๊ะ' });
    }

    // 1. Get store details to check plan limit
    const storeRes = await query(`SELECT plan_name FROM stores WHERE id = $1`, [storeId]);
    const planName = (storeRes.rows[0]?.plan_name || 'Professional').toLowerCase();

    // 2. Count existing active non-takeaway tables (excluding takeaway/หน้าร้าน)
    const countRes = await query(
      `SELECT COUNT(*) as count FROM restaurant_tables 
       WHERE store_id = $1 AND is_active = TRUE AND is_takeaway = FALSE AND table_number != 'กลับบ้าน' AND table_number != 'สั่งกลับบ้าน'`,
      [storeId]
    );
    const currentTableCount = parseInt(countRes.rows[0]?.count || 0, 10);

    // Plan table limits (excluding takeaway table)
    let maxTables = 20; // Default Professional
    let planDisplayName = 'Professional';

    if (planName.includes('starter')) {
      maxTables = 10;
      planDisplayName = 'Starter';
    } else if (planName.includes('enterprise') || planName.includes('buffet')) {
      maxTables = Infinity;
      planDisplayName = 'Enterprise';
    } else {
      maxTables = 20;
      planDisplayName = 'Professional';
    }

    if (currentTableCount >= maxTables) {
      return res.status(403).json({
        success: false,
        code: 'PLAN_LIMIT_EXCEEDED',
        message: `แพ็กเกจ ${planDisplayName} สามารถเพิ่มโต๊ะอาหารได้สูงสุด ${maxTables} โต๊ะ (ไม่รวมโต๊ะหน้าร้าน/สั่งกลับบ้าน) หากต้องการเพิ่มโต๊ะเพิ่มเติม กรุณาอัปเกรดแพ็กเกจ Enterprise`,
        currentCount: currentTableCount,
        maxLimit: maxTables,
      });
    }

    let finalZoneId = zone_id ? (parseInt(zone_id, 10) || null) : null;
    if (zone_name && zone_name.trim()) {
      const zName = zone_name.trim();
      const existingZone = await query(`SELECT id FROM table_zones WHERE store_id = $1 AND name = $2`, [storeId, zName]);
      if (existingZone.rows.length > 0) {
        finalZoneId = existingZone.rows[0].id;
      } else {
        const insertZ = await query(`INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, 99) RETURNING id`, [storeId, zName]);
        finalZoneId = insertZ.rows[0].id;
      }
    }

    const qrToken = `tbl-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;

    const insertRes = await query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
       VALUES ($1, $2, $3, $4, $5, 'available', FALSE) RETURNING *`,
      [storeId, finalZoneId, table_number.trim(), seat_capacity || 4, qrToken]
    );

    broadcastToStore(storeId, 'table_updated', { action: 'created', table: insertRes.rows[0] });
    return res.json({ success: true, message: 'เพิ่มโต๊ะอาหารเรียบร้อย', table: insertRes.rows[0] });
  } catch (err) {
    console.error('[Admin createTable Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด (อาจมีหมายเลขโต๊ะนี้แล้ว)' });
  }
}

async function updateTable(req, res) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;
    const { table_number, zone_id, zone_name, seat_capacity, status } = req.body;

    let finalZoneId = undefined;
    let zoneSpecified = false;

    if (zone_name !== undefined && zone_name !== null && zone_name.trim() !== '') {
      zoneSpecified = true;
      const zName = zone_name.trim();
      const existingZone = await query(`SELECT id FROM table_zones WHERE store_id = $1 AND name = $2`, [storeId, zName]);
      if (existingZone.rows.length > 0) {
        finalZoneId = existingZone.rows[0].id;
      } else {
        const insertZ = await query(`INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, 99) RETURNING id`, [storeId, zName]);
        finalZoneId = insertZ.rows[0].id;
      }
    } else if (zone_id !== undefined) {
      zoneSpecified = true;
      finalZoneId = (zone_id && parseInt(zone_id, 10)) ? parseInt(zone_id, 10) : null;
    }

    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (table_number !== undefined) {
      updates.push(`table_number = $${paramIdx++}`);
      values.push(table_number.trim());
    }
    if (zoneSpecified) {
      updates.push(`zone_id = $${paramIdx++}`);
      values.push(finalZoneId);
    }
    if (seat_capacity !== undefined) {
      updates.push(`seat_capacity = $${paramIdx++}`);
      values.push(parseInt(seat_capacity, 10) || 4);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIdx++}`);
      values.push(status);
      if (status === 'available') {
        updates.push(`current_order_id = NULL`);
        await query(
          `UPDATE orders SET status = 'cancelled' WHERE table_id = $1 AND store_id = $2 AND status = 'active' AND payment_status = 'pending'`,
          [id, storeId]
        );
      }
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    values.push(id);
    const idParam = `$${paramIdx++}`;
    values.push(storeId);
    const storeIdParam = `$${paramIdx++}`;

    const updateSql = `UPDATE restaurant_tables SET ${updates.join(', ')} WHERE id = ${idParam} AND store_id = ${storeIdParam} RETURNING *`;
    const updateRes = await query(updateSql, values);

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบโต๊ะ' });
    }

    broadcastToStore(storeId, 'table_updated', { action: 'updated', table: updateRes.rows[0] });
    broadcastToStore(storeId, 'table_status_updated', { table: updateRes.rows[0] });
    return res.json({ success: true, message: 'อัปเดตข้อมูลโต๊ะเรียบร้อย', table: updateRes.rows[0] });
  } catch (err) {
    console.error('[Admin updateTable Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function deleteTable(req, res) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const check = await query(`SELECT is_takeaway, table_number FROM restaurant_tables WHERE id = $1 AND store_id = $2`, [id, storeId]);
    if (check.rows.length > 0 && (check.rows[0].is_takeaway || check.rows[0].table_number === 'กลับบ้าน' || check.rows[0].table_number === 'สั่งกลับบ้าน')) {
      return res.status(400).json({ success: false, message: 'โต๊ะสั่งกลับบ้าน (Takeaway) เป็นโต๊ะหลักประจำร้าน ไม่สามารถลบได้' });
    }

    await query(`UPDATE restaurant_tables SET is_active = FALSE WHERE id = $1 AND store_id = $2`, [id, storeId]);
    broadcastToStore(storeId, 'table_updated', { action: 'deleted', tableId: id });
    return res.json({ success: true, message: 'ลบโต๊ะเรียบร้อย' });
  } catch (err) {
    console.error('[Admin deleteTable Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

// -------------------------------------------------------------
// Zone Management
// -------------------------------------------------------------
async function getZones(req, res) {
  try {
    const storeId = getStoreId(req);
    const zonesRes = await query(
      `SELECT z.*, 
              (SELECT COUNT(*) FROM restaurant_tables t WHERE t.zone_id = z.id AND t.is_active = TRUE) as table_count
       FROM table_zones z
       WHERE z.store_id = $1
       ORDER BY z.sort_order ASC, z.id ASC`,
      [storeId]
    );
    return res.json({ success: true, zones: zonesRes.rows });
  } catch (err) {
    console.error('[Admin getZones Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลโซน' });
  }
}

async function createZone(req, res) {
  try {
    const storeId = getStoreId(req);
    const { name, sort_order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อโซน' });
    }
    const cleanName = name.trim();
    const existing = await query(`SELECT id FROM table_zones WHERE store_id = $1 AND name = $2`, [storeId, cleanName]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'มีโซนชื่อนี้อยู่แล้ว' });
    }
    const insertRes = await query(
      `INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [storeId, cleanName, sort_order || 99]
    );
    return res.json({ success: true, message: 'เพิ่มโซนเรียบร้อย', zone: insertRes.rows[0] });
  } catch (err) {
    console.error('[Admin createZone Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function updateZone(req, res) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;
    const { name, sort_order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อโซน' });
    }
    const cleanName = name.trim();
    const updateRes = await query(
      `UPDATE table_zones SET name = $1, sort_order = COALESCE($2, sort_order) WHERE id = $3 AND store_id = $4 RETURNING *`,
      [cleanName, sort_order, id, storeId]
    );
    if (updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบโซน' });
    }
    return res.json({ success: true, message: 'แก้ไขโซนเรียบร้อย', zone: updateRes.rows[0] });
  } catch (err) {
    console.error('[Admin updateZone Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function deleteZone(req, res) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;
    await query(`UPDATE restaurant_tables SET zone_id = NULL WHERE zone_id = $1 AND store_id = $2`, [id, storeId]);
    await query(`DELETE FROM table_zones WHERE id = $1 AND store_id = $2`, [id, storeId]);
    return res.json({ success: true, message: 'ลบโซนเรียบร้อย' });
  } catch (err) {
    console.error('[Admin deleteZone Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

// -------------------------------------------------------------
// 3. Kitchen Display System (KDS)
// -------------------------------------------------------------
async function getKitchenOrders(req, res) {
  try {
    const storeId = getStoreId(req);

    // Get all active order items for kitchen display
    const itemsRes = await query(
      `SELECT oi.*, o.order_number, o.customer_name, t.table_number, t.id as table_id, t.is_takeaway,
              c.name as category_name,
              COALESCE(json_agg(json_build_object('id', oio.id, 'name', oio.option_name, 'extra_price', oio.extra_price)) 
                       FILTER (WHERE oio.id IS NOT NULL), '[]') as options
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       JOIN restaurant_tables t ON o.table_id = t.id
       LEFT JOIN menus m ON oi.menu_id = m.id
       LEFT JOIN categories c ON m.category_id = c.id
       LEFT JOIN order_item_options oio ON oi.id = oio.order_item_id
       WHERE o.store_id = $1 AND o.status = 'active' AND oi.status IN ('pending', 'cooking', 'ready')
       GROUP BY oi.id, o.order_number, o.customer_name, t.table_number, t.id, t.is_takeaway, c.name
       ORDER BY oi.ordered_at ASC`,
      [storeId]
    );

    return res.json({ success: true, items: itemsRes.rows });
  } catch (err) {
    console.error('[Admin getKitchenOrders Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function updateKitchenItemStatus(req, res) {
  try {
    const storeId = getStoreId(req);
    const { itemId } = req.params;
    const { status } = req.body; // 'cooking', 'ready', 'served', 'cancelled'

    const itemRes = await query(
      `UPDATE order_items oi
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       FROM orders o
       WHERE oi.id = $2 AND oi.order_id = o.id AND o.store_id = $3
       RETURNING oi.*, o.store_id, o.table_id`,
      [status, itemId, storeId]
    );

    if (itemRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบรายการอาหาร' });
    }

    const updatedItem = itemRes.rows[0];
    const tableRes = await query(`SELECT * FROM restaurant_tables WHERE id = $1`, [updatedItem.table_id]);
    const storeRes = await query(`SELECT * FROM stores WHERE id = $1`, [storeId]);

    // If item status became 'ready', trigger Telegram to Service Group
    if (status === 'ready' && storeRes.rows.length > 0 && tableRes.rows.length > 0) {
      await sendServiceReadyNotification(storeRes.rows[0], updatedItem, tableRes.rows[0]);
    }

    // Broadcast Real-time
    broadcastToStore(storeId, 'order_item_status_updated', {
      orderItemId: updatedItem.id,
      orderId: updatedItem.order_id,
      tableId: updatedItem.table_id,
      status,
      item: updatedItem,
    });
    broadcastToOrder(updatedItem.order_id, 'item_status_updated', {
      orderItemId: updatedItem.id,
      status,
    });

    return res.json({ success: true, message: `อัปเดตสถานะเป็น ${status} เรียบร้อย`, item: updatedItem });
  } catch (err) {
    console.error('[Admin updateKitchenItemStatus Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตสถานะ' });
  }
}

// -------------------------------------------------------------
// 4. POS / Cashier & Billing
// -------------------------------------------------------------
async function getTableBill(req, res) {
  try {
    const storeId = getStoreId(req);
    const { tableId } = req.params;

    const tableRes = await query(`SELECT * FROM restaurant_tables WHERE id = $1 AND store_id = $2`, [tableId, storeId]);
    if (tableRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบโต๊ะ' });
    }
    const table = tableRes.rows[0];

    const orderRes = await query(
      `SELECT * FROM orders WHERE table_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
      [table.id]
    );

    if (orderRes.rows.length === 0) {
      return res.json({ success: true, table, order: null, items: [] });
    }
    const order = orderRes.rows[0];

    const itemsRes = await query(
      `SELECT oi.*, 
              COALESCE(json_agg(json_build_object('id', oio.id, 'name', oio.option_name, 'extra_price', oio.extra_price)) 
                       FILTER (WHERE oio.id IS NOT NULL), '[]') as options
       FROM order_items oi
       LEFT JOIN order_item_options oio ON oi.id = oio.order_item_id
       WHERE oi.order_id = $1 AND oi.status != 'cancelled'
       GROUP BY oi.id
       ORDER BY oi.id ASC`,
      [order.id]
    );

    const storeRes = await query(`SELECT * FROM stores WHERE id = $1`, [storeId]);
    const store = storeRes.rows[0];

    // Generate PromptPay QR Code payload & image
    let promptPayQR = store.promptpay_qr_url || null;
    if (!promptPayQR && store.promptpay_number) {
      // In production/demo, generate PromptPay QR string or data URL
      const ppData = `promptpay://${store.promptpay_number}?amount=${order.net_amount}`;
      promptPayQR = await QRCode.toDataURL(ppData, { width: 250, margin: 2 });
    }

    return res.json({
      success: true,
      table,
      order,
      items: itemsRes.rows,
      store,
      promptPayQR,
    });
  } catch (err) {
    console.error('[Admin getTableBill Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function checkoutOrder(req, res) {
  const client = await getClient();
  try {
    const storeId = getStoreId(req);
    const { orderId } = req.params;
    const { payment_method, amount_received, discount_amount } = req.body;

    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND store_id = $2 AND status = 'active' FOR UPDATE`,
      [orderId, storeId]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบบิลที่เปิดอยู่' });
    }
    const order = orderRes.rows[0];

    const storeRes = await client.query(`SELECT * FROM stores WHERE id = $1`, [storeId]);
    const store = storeRes.rows[0];

    // Direct net amount calculation without VAT or Service charge
    const discount = parseFloat(discount_amount || 0);
    const subtotal = parseFloat(order.subtotal_amount);
    const subtotalAfterDiscount = Math.max(0, subtotal - discount);
    const serviceAmount = 0;
    const vatAmount = 0;
    const netAmount = subtotalAfterDiscount;

    const received = parseFloat(amount_received || netAmount);
    const changeAmount = Math.max(0, received - netAmount);

    // 1. Update Order Status
    await client.query(
      `UPDATE orders SET
        discount_amount = $1,
        service_amount = $2,
        vat_amount = $3,
        net_amount = $4,
        payment_status = 'paid',
        status = 'completed',
        closed_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [discount, serviceAmount, vatAmount, netAmount, order.id]
    );

    // 2. Insert Payment Record
    const paymentRes = await client.query(
      `INSERT INTO payments (order_id, store_id, payment_method, amount_received, change_amount, received_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [order.id, storeId, payment_method || 'cash', received, changeAmount, req.user?.id || null]
    );

    // 3. Mark all order items as served
    await client.query(
      `UPDATE order_items SET status = 'served' WHERE order_id = $1 AND status != 'cancelled'`,
      [order.id]
    );

    // 4. Release Table to available and clear current_order_id
    await client.query(
      `UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE id = $1`,
      [order.table_id]
    );

    // 5. Mark any pending service calls for this table as done
    await client.query(
      `UPDATE service_calls SET status = 'done', resolved_at = CURRENT_TIMESTAMP WHERE table_id = $1 AND status = 'pending'`,
      [order.table_id]
    );

    await client.query('COMMIT');

    // Broadcast Real-time
    broadcastToStore(storeId, 'payment_completed', {
      orderId: order.id,
      tableId: order.table_id,
      netAmount,
      changeAmount,
      paymentMethod: payment_method,
    });
    broadcastToStore(storeId, 'table_status_updated', {
      tableId: order.table_id,
      status: 'available',
    });
    broadcastToOrder(order.id, 'order_completed', {
      orderId: order.id,
      status: 'completed',
    });

    return res.json({
      success: true,
      message: 'ชำระเงินและปิดบิลเรียบร้อย โต๊ะพร้อมรับลูกค้าใหม่แล้ว!',
      payment: paymentRes.rows[0],
      changeAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Admin checkoutOrder Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเช็คบิล' });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// 5. Menu Management & Stock Toggling
// -------------------------------------------------------------
async function getMenus(req, res) {
  try {
    const storeId = getStoreId(req);

    const categoriesRes = await query(
      `SELECT * FROM categories WHERE store_id = $1 ORDER BY sort_order ASC, id ASC`,
      [storeId]
    );

    const menusRes = await query(
      `SELECT m.*, c.name as category_name
       FROM menus m
       JOIN categories c ON m.category_id = c.id
       WHERE m.store_id = $1
       ORDER BY c.sort_order ASC, m.sort_order ASC, m.id ASC`,
      [storeId]
    );

    const optGroupRes = await query(
      `SELECT mog.menu_id, og.id as group_id, og.name as group_name, og.is_required, og.min_select, og.max_select,
              oi.id as item_id, oi.name as item_name, oi.extra_price, oi.is_available as item_available, oi.sort_order
       FROM menu_option_groups mog
       JOIN option_groups og ON mog.group_id = og.id
       JOIN option_items oi ON og.id = oi.group_id
       WHERE og.store_id = $1
       ORDER BY og.id ASC, oi.sort_order ASC, oi.id ASC`,
      [storeId]
    );

    const menuMap = {};
    for (const m of menusRes.rows) {
      m.option_groups = [];
      menuMap[m.id] = m;
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
        is_available: row.item_available,
        sort_order: row.sort_order,
      });
    }

    return res.json({
      success: true,
      categories: categoriesRes.rows,
      menus: menusRes.rows,
      optionGroups: optGroupRes.rows,
    });
  } catch (err) {
    console.error('[Admin getMenus Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function saveMenuOptionGroups(queryFunc, storeId, menuId, optionGroups) {
  if (!Array.isArray(optionGroups)) return;

  // 1. Get existing option groups linked to this menu
  const existingLinks = await queryFunc(
    `SELECT group_id FROM menu_option_groups WHERE menu_id = $1`,
    [menuId]
  );
  const oldGroupIds = existingLinks.rows.map(r => r.group_id);

  // Remove existing links
  await queryFunc(`DELETE FROM menu_option_groups WHERE menu_id = $1`, [menuId]);

  // If old groups are no longer linked to any other menu, clean them up
  for (const oldGid of oldGroupIds) {
    const checkRes = await queryFunc(`SELECT 1 FROM menu_option_groups WHERE group_id = $1 LIMIT 1`, [oldGid]);
    if (checkRes.rows.length === 0) {
      await queryFunc(`DELETE FROM option_groups WHERE id = $1 AND store_id = $2`, [oldGid, storeId]);
    }
  }

  // 2. Insert new groups and items
  for (const group of optionGroups) {
    const groupName = (group.name || '').trim();
    if (!groupName) continue;
    const items = Array.isArray(group.items) ? group.items.filter(it => it && (it.name || '').trim() !== '') : [];
    if (items.length === 0) continue;

    const isRequired = group.is_required === true || group.is_required === 'true';
    const maxSelect = parseInt(group.max_select || 1, 10);
    const minSelect = isRequired ? 1 : 0;

    const groupRes = await queryFunc(
      `INSERT INTO option_groups (store_id, name, is_required, min_select, max_select)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [storeId, groupName, isRequired, minSelect, maxSelect]
    );
    const newGroupId = groupRes.rows[0].id;

    // Link group to menu
    await queryFunc(
      `INSERT INTO menu_option_groups (menu_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [menuId, newGroupId]
    );

    // Insert items
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const itemName = it.name.trim();
      const extraPrice = parseFloat(it.extra_price || 0);
      await queryFunc(
        `INSERT INTO option_items (group_id, name, extra_price, is_available, sort_order)
         VALUES ($1, $2, $3, TRUE, $4)`,
        [newGroupId, itemName, extraPrice, i]
      );
    }
  }
}

async function toggleMenuAvailability(req, res) {
  try {
    const storeId = getStoreId(req);
    const { menuId } = req.params;

    const menuRes = await query(
      `UPDATE menus SET is_available = NOT is_available, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND store_id = $2 RETURNING *`,
      [menuId, storeId]
    );

    if (menuRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบเมนู' });
    }

    broadcastToStore(storeId, 'menu_availability_changed', { menu: menuRes.rows[0] });
    return res.json({
      success: true,
      message: `เปลี่ยนสถานะเป็น ${menuRes.rows[0].is_available ? 'พร้อมขาย' : 'ของหมด'} เรียบร้อย`,
      menu: menuRes.rows[0],
    });
  } catch (err) {
    console.error('[Admin toggleMenuAvailability Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function createMenu(req, res) {
  try {
    const storeId = getStoreId(req);
    const { category_id, name, description, price, special_price, image_url, is_recommend, option_groups } = req.body;

    if (!category_id || !name || price === undefined || price === null || price === '') {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลสำคัญให้ครบถ้วน' });
    }

    const insertRes = await query(
      `INSERT INTO menus (store_id, category_id, name, description, price, special_price, image_url, is_recommend)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        storeId,
        parseInt(category_id, 10),
        name.trim(),
        description || '',
        parseFloat(price),
        special_price ? parseFloat(special_price) : null,
        image_url || '',
        is_recommend === true || is_recommend === 'true'
      ]
    );

    const createdMenu = insertRes.rows[0];

    if (option_groups && Array.isArray(option_groups)) {
      await saveMenuOptionGroups(query, storeId, createdMenu.id, option_groups);
    }

    broadcastToStore(storeId, 'menu_updated', { action: 'created', menu: createdMenu });
    return res.json({ success: true, message: 'เพิ่มเมนูอาหารเรียบร้อย', menu: createdMenu });
  } catch (err) {
    console.error('[Admin createMenu Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function updateMenu(req, res) {
  try {
    const storeId = getStoreId(req);
    const { menuId } = req.params;
    const { category_id, name, description, price, special_price, image_url, is_recommend, is_available, option_groups } = req.body;

    if (!category_id || !name || price === undefined || price === null || price === '') {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลสำคัญให้ครบถ้วน' });
    }

    const updateRes = await query(
      `UPDATE menus SET
        category_id = $1,
        name = $2,
        description = $3,
        price = $4,
        special_price = $5,
        image_url = $6,
        is_recommend = $7,
        is_available = COALESCE($8, is_available),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND store_id = $10
       RETURNING *`,
      [
        parseInt(category_id, 10),
        name.trim(),
        description || '',
        parseFloat(price),
        special_price ? parseFloat(special_price) : null,
        image_url || '',
        is_recommend === true || is_recommend === 'true',
        is_available !== undefined && is_available !== null ? (is_available === true || is_available === 'true') : null,
        menuId,
        storeId,
      ]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบเมนูอาหารนี้' });
    }

    if (option_groups !== undefined && Array.isArray(option_groups)) {
      await saveMenuOptionGroups(query, storeId, menuId, option_groups);
    }

    broadcastToStore(storeId, 'menu_updated', { action: 'updated', menu: updateRes.rows[0] });
    return res.json({ success: true, message: 'บันทึกการแก้ไขเมนูเรียบร้อย', menu: updateRes.rows[0] });
  } catch (err) {
    console.error('[Admin updateMenu Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการแก้ไขเมนู' });
  }
}

async function deleteMenu(req, res) {
  try {
    const storeId = getStoreId(req);
    const { menuId } = req.params;

    await saveMenuOptionGroups(query, storeId, menuId, []);

    const delRes = await query(`DELETE FROM menus WHERE id = $1 AND store_id = $2 RETURNING id`, [menuId, storeId]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบเมนูอาหาร' });
    }

    broadcastToStore(storeId, 'menu_updated', { action: 'deleted', menuId });
    return res.json({ success: true, message: 'ลบเมนูอาหารเรียบร้อย' });
  } catch (err) {
    console.error('[Admin deleteMenu Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบเมนู' });
  }
}

// -------------------------------------------------------------
// 6. Reports & Analytics
// -------------------------------------------------------------
function buildDateFilter(period, startDate, endDate, dateCol, params) {
  const col = `(${dateCol} AT TIME ZONE 'Asia/Bangkok')`;
  const curDate = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date`;
  const curTs = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')`;

  if (period === 'today') {
    return `AND DATE(${col}) = ${curDate}`;
  } else if (period === 'yesterday') {
    return `AND DATE(${col}) = (${curDate} - INTERVAL '1 day')`;
  } else if (period === 'this_week') {
    return `AND DATE_TRUNC('week', ${col}) = DATE_TRUNC('week', ${curTs})`;
  } else if (period === 'this_month') {
    return `AND DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', ${curTs})`;
  } else if (period === 'last_month') {
    return `AND DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', ${curTs} - INTERVAL '1 month')`;
  } else if (period === 'all') {
    return ``;
  } else if (period === 'custom' && startDate && endDate) {
    params.push(startDate);
    const startIdx = params.length;
    params.push(endDate);
    const endIdx = params.length;
    return `AND DATE(${col}) >= $${startIdx}::date AND DATE(${col}) <= $${endIdx}::date`;
  }
  // Default: 'today'
  return `AND DATE(${col}) = ${curDate}`;
}

async function getReports(req, res) {
  try {
    const storeId = getStoreId(req);

    const { 
      topPeriod, topStartDate, topEndDate, 
      payPeriod, payStartDate, payEndDate, 
      txPeriod, txStartDate, txEndDate, 
      startDate, endDate 
    } = req.query;

    // Sales by Day (Last 30 days)
    const dailySalesRes = await query(
      `SELECT DATE(closed_at) as sale_date, SUM(net_amount) as total_sales, COUNT(id) as total_orders
       FROM orders
       WHERE store_id = $1 AND payment_status = 'paid'
         AND closed_at >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY DATE(closed_at)
       ORDER BY DATE(closed_at) ASC`,
      [storeId]
    );

    // Top 10 Best Selling Items with Filter (all, custom, etc.)
    const topParams = [storeId];
    const topFilterSql = buildDateFilter(
      topPeriod || 'all', 
      topStartDate || startDate, 
      topEndDate || endDate, 
      'COALESCE(o.closed_at, o.opened_at)', 
      topParams
    );

    const topItemsRes = await query(
      `SELECT oi.menu_name, SUM(oi.quantity) as total_qty, SUM(oi.total_price) as total_revenue
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.store_id = $1 AND o.payment_status = 'paid' ${topFilterSql}
       GROUP BY oi.menu_name
       ORDER BY total_qty DESC LIMIT 10`,
      topParams
    );

    // Payment Methods Breakdown with Filter (today, yesterday, this_week, this_month, last_month, all, custom)
    const effectivePayPeriod = payPeriod || txPeriod || 'today';
    const effectivePayStart = payStartDate || txStartDate || startDate;
    const effectivePayEnd = payEndDate || txEndDate || endDate;

    const payParams = [storeId];
    const payFilterSql = buildDateFilter(
      effectivePayPeriod, 
      effectivePayStart, 
      effectivePayEnd, 
      'p.paid_at', 
      payParams
    );

    const paymentMethodsRes = await query(
      `SELECT p.payment_method, SUM(p.amount_received - p.change_amount) as total_amount, COUNT(p.id) as count
       FROM payments p
       WHERE p.store_id = $1 ${payFilterSql}
       GROUP BY p.payment_method`,
      payParams
    );

    // Detailed Orders / Transactions History linked with Payment Filter
    const txParams = [storeId];
    const txFilterSql = buildDateFilter(
      effectivePayPeriod,
      effectivePayStart,
      effectivePayEnd,
      'COALESCE(p.paid_at, o.closed_at, o.opened_at)',
      txParams
    );

    const transactionsRes = await query(
      `SELECT o.id, o.order_number, o.customer_name, o.customer_count,
              o.subtotal_amount, o.discount_amount, o.service_amount, o.vat_amount, o.net_amount,
              o.opened_at, o.closed_at,
              t.table_number, z.name as zone_name,
              p.id as payment_id, p.payment_method, p.amount_received, p.change_amount, 
              COALESCE(p.paid_at, o.closed_at, o.opened_at) as paid_at,
              COALESCE(u.full_name, u.username, 'สมชาย ผู้จัดการร้านแซ่บ') as receiver_name,
              COALESCE(u.role, 'manager') as receiver_role,
              (
                SELECT json_agg(json_build_object(
                  'menu_name', oi.menu_name,
                  'quantity', oi.quantity,
                  'unit_price', oi.unit_price,
                  'total_price', oi.total_price,
                  'special_notes', oi.special_notes
                ))
                FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'
              ) as items
       FROM orders o
       LEFT JOIN restaurant_tables t ON o.table_id = t.id
       LEFT JOIN table_zones z ON t.zone_id = z.id
       LEFT JOIN payments p ON p.order_id = o.id
       LEFT JOIN users u ON p.received_by = u.id
       WHERE o.store_id = $1 AND o.payment_status = 'paid' ${txFilterSql}
       ORDER BY COALESCE(p.paid_at, o.closed_at, o.opened_at) DESC
       LIMIT 200`,
      txParams
    );

    return res.json({
      success: true,
      dailySales: dailySalesRes.rows,
      topItems: topItemsRes.rows,
      paymentMethods: paymentMethodsRes.rows,
      transactions: transactionsRes.rows,
    });
  } catch (err) {
    console.error('[Admin getReports Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดรายงาน' });
  }
}

async function updateTransaction(req, res) {
  const client = await getClient();
  try {
    const storeId = getStoreId(req);
    const orderId = parseInt(req.params.id, 10);
    const { 
      payment_method, 
      customer_name, 
      discount_amount, 
      amount_received, 
      change_amount, 
      paid_at 
    } = req.body;

    await client.query('BEGIN');

    // 1. Verify order exists and belongs to store
    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND store_id = $2`,
      [orderId, storeId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลบิลนี้' });
    }

    const order = orderRes.rows[0];
    const newDiscount = (discount_amount !== undefined && discount_amount !== null && discount_amount !== '') 
      ? parseFloat(discount_amount) 
      : parseFloat(order.discount_amount || 0);
    const subtotal = parseFloat(order.subtotal_amount || 0);
    const vat = parseFloat(order.vat_amount || 0);
    const service = parseFloat(order.service_amount || 0);
    const newNetAmount = Math.max(0, subtotal - newDiscount + vat + service);

    // 2. Update order record
    await client.query(
      `UPDATE orders 
       SET customer_name = COALESCE($1, customer_name),
           discount_amount = $2,
           net_amount = $3,
           closed_at = COALESCE($4, closed_at)
       WHERE id = $5 AND store_id = $6`,
      [
        customer_name !== undefined ? customer_name : null,
        newDiscount,
        newNetAmount,
        paid_at ? new Date(paid_at) : null,
        orderId,
        storeId
      ]
    );

    // 3. Update payment record if exists
    if (payment_method || amount_received !== undefined || change_amount !== undefined || paid_at) {
      const payRes = await client.query(
        `SELECT id FROM payments WHERE order_id = $1 AND store_id = $2 ORDER BY id DESC LIMIT 1`,
        [orderId, storeId]
      );
      if (payRes.rows.length > 0) {
        const payId = payRes.rows[0].id;
        const newMethod = payment_method || 'promptpay';
        const newReceived = amount_received !== undefined && amount_received !== null && amount_received !== ''
          ? parseFloat(amount_received)
          : (newMethod === 'cash' ? newNetAmount : newNetAmount);
        const newChange = change_amount !== undefined && change_amount !== null && change_amount !== ''
          ? parseFloat(change_amount)
          : (newMethod === 'cash' ? Math.max(0, newReceived - newNetAmount) : 0);

        await client.query(
          `UPDATE payments
           SET payment_method = $1,
               amount_received = $2,
               change_amount = $3,
               paid_at = COALESCE($4, paid_at)
           WHERE id = $5 AND store_id = $6`,
          [
            newMethod,
            newReceived,
            newChange,
            paid_at ? new Date(paid_at) : null,
            payId,
            storeId
          ]
        );
      }
    }

    await client.query('COMMIT');
    return res.json({ success: true, message: 'บันทึกการแก้ไขข้อมูลบิลสำเร็จ' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Admin updateTransaction Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการแก้ไขบิล' });
  } finally {
    client.release();
  }
}

async function deleteTransaction(req, res) {
  const client = await getClient();
  try {
    const storeId = getStoreId(req);
    const orderId = parseInt(req.params.id, 10);

    await client.query('BEGIN');

    // 1. Verify order exists and belongs to store
    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND store_id = $2`,
      [orderId, storeId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลบิลนี้' });
    }

    // 2. Delete payments, order_item_options, order_items, and orders
    await client.query(`DELETE FROM payments WHERE order_id = $1 AND store_id = $2`, [orderId, storeId]);
    await client.query(
      `DELETE FROM order_item_options WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
      [orderId]
    );
    await client.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
    await client.query(`DELETE FROM orders WHERE id = $1 AND store_id = $2`, [orderId, storeId]);

    await client.query('COMMIT');
    return res.json({ success: true, message: 'ลบข้อมูลบิลออกจากระบบเรียบร้อยแล้ว' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Admin deleteTransaction Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบบิล' });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// 7. Store Settings & Telegram Bot Configuration
// -------------------------------------------------------------
async function getSettings(req, res) {
  try {
    const storeId = getStoreId(req);
    const storeRes = await query(`SELECT * FROM stores WHERE id = $1`, [storeId]);
    return res.json({ success: true, store: storeRes.rows[0], simulatedMessages: getSimulatedMessages(storeId) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function updateSettings(req, res) {
  try {
    const storeId = getStoreId(req);
    const {
      name,
      logo_url,
      promptpay_qr_url,
      address,
      phone_number,
      promptpay_number,
      promptpay_name,
      vat_rate,
      service_charge,
      telegram_bot_token,
      telegram_kitchen_chat_id,
      telegram_service_chat_id,
      telegram_slip_chat_id,
      is_open,
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (logo_url !== undefined) { fields.push(`logo_url = $${idx++}`); values.push(logo_url || null); }
    if (promptpay_qr_url !== undefined) { fields.push(`promptpay_qr_url = $${idx++}`); values.push(promptpay_qr_url || null); }
    if (address !== undefined) { fields.push(`address = $${idx++}`); values.push(address); }
    if (phone_number !== undefined) { fields.push(`phone_number = $${idx++}`); values.push(phone_number); }
    if (promptpay_number !== undefined) { fields.push(`promptpay_number = $${idx++}`); values.push(promptpay_number); }
    if (promptpay_name !== undefined) { fields.push(`promptpay_name = $${idx++}`); values.push(promptpay_name); }
    if (vat_rate !== undefined) { fields.push(`vat_rate = $${idx++}`); values.push(vat_rate); }
    if (service_charge !== undefined) { fields.push(`service_charge = $${idx++}`); values.push(service_charge); }
    if (telegram_bot_token !== undefined) { fields.push(`telegram_bot_token = $${idx++}`); values.push(telegram_bot_token); }
    if (telegram_kitchen_chat_id !== undefined) { fields.push(`telegram_kitchen_chat_id = $${idx++}`); values.push(telegram_kitchen_chat_id); }
    if (telegram_service_chat_id !== undefined) { fields.push(`telegram_service_chat_id = $${idx++}`); values.push(telegram_service_chat_id); }
    if (telegram_slip_chat_id !== undefined) { fields.push(`telegram_slip_chat_id = $${idx++}`); values.push(telegram_slip_chat_id); }
    if (is_open !== undefined) { fields.push(`is_open = $${idx++}`); values.push(is_open); }

    if (fields.length === 0) {
      const currentStore = await query(`SELECT * FROM stores WHERE id = $1`, [storeId]);
      return res.json({ success: true, message: 'ไม่มีการเปลี่ยนแปลง', store: currentStore.rows[0] });
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(storeId);

    const updateSql = `UPDATE stores SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    const updateRes = await query(updateSql, values);

    return res.json({ success: true, message: 'บันทึกการตั้งค่าร้านค้าเรียบร้อย', store: updateRes.rows[0] });
  } catch (err) {
    console.error('[Admin updateSettings Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function toggleStoreOpen(req, res) {
  try {
    const storeId = getStoreId(req);
    const { is_open } = req.body;

    let newStatus;
    if (is_open !== undefined) {
      newStatus = Boolean(is_open);
    } else {
      const cur = await query(`SELECT is_open FROM stores WHERE id = $1`, [storeId]);
      newStatus = !cur.rows[0]?.is_open;
    }

    const updateRes = await query(
      `UPDATE stores SET is_open = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, is_open, plan_name, trial_ends_at, logo_url`,
      [newStatus, storeId]
    );

    broadcastToStore(storeId, 'store_status_updated', { is_open: newStatus, store: updateRes.rows[0] });

    return res.json({
      success: true,
      message: newStatus ? 'เปิดร้านรับออเดอร์เรียบร้อยแล้ว' : 'ปิดร้านชั่วคราวเรียบร้อยแล้ว',
      is_open: newStatus,
      store: updateRes.rows[0],
    });
  } catch (err) {
    console.error('[Admin toggleStoreOpen Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเปลี่ยนสถานะร้านค้า' });
  }
}

async function testTelegram(req, res) {
  try {
    const storeId = getStoreId(req);
    const { channel, message } = req.body; // 'kitchen', 'service', or 'slip'
    const storeRes = await query(`SELECT * FROM stores WHERE id = $1`, [storeId]);
    const store = storeRes.rows[0];

    let chatId = store.telegram_kitchen_chat_id;
    let channelName = 'ทีมครัว';
    if (channel === 'service') {
      chatId = store.telegram_service_chat_id;
      channelName = 'ทีมบริการ/เสิร์ฟ';
    } else if (channel === 'slip') {
      chatId = store.telegram_slip_chat_id;
      channelName = 'กลุ่มสลิปลูกค้า (แจ้งเตือนสลิปโอนเงิน)';
    }

    const text = `🔔 <b>[ทดสอบระบบแจ้งเตือน Telegram]</b>\n` +
      `ร้าน: ${store.name}\n` +
      `ช่องทาง: ${channelName}\n` +
      `ข้อความ: ${message || 'ระบบทำงานปกติ พร้อมรับออเดอร์แล้ว!'}\n` +
      `เวลา: ${new Date().toLocaleTimeString('th-TH')}`;

    const result = await sendTelegramMessage(store.telegram_bot_token, chatId, text, null, storeId);
    return res.json({ success: true, message: 'ส่งข้อความทดสอบเรียบร้อย', result });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function simulateTelegramCallback(req, res) {
  try {
    const { callback_data } = req.body;
    await handleTelegramWebhook({
      callback_query: {
        data: callback_data,
        message: { text: 'Simulated telegram callback' },
        id: 'sim-' + Date.now(),
      },
    });
    return res.json({ success: true, message: 'จำลองการกดยืนยันบน Telegram สำเร็จ!' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

async function clearTelegramSimulation(req, res) {
  try {
    const storeId = getStoreId(req);
    clearSimulatedMessages(storeId);
    return res.json({ success: true, message: 'ล้างข้อมูลข้อความทดสอบเรียบร้อยแล้ว' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
}

// -------------------------------------------------------------
// 8. Staff Management for Store (Manager only)
// -------------------------------------------------------------
async function getStaffList(req, res) {
  try {
    const storeId = getStoreId(req);
    const staffRes = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone_number, u.avatar_url,
              u.role as global_role, su.role as store_role, su.is_active, u.created_at
       FROM store_users su
       JOIN users u ON su.user_id = u.id
       WHERE su.store_id = $1
       ORDER BY CASE WHEN su.role = 'manager' THEN 1 ELSE 2 END, u.id ASC`,
      [storeId]
    );

    return res.json({
      success: true,
      staff: staffRes.rows
    });
  } catch (err) {
    console.error('[Admin getStaffList Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลพนักงาน' });
  }
}

async function createStaff(req, res) {
  const client = await getClient();
  try {
    const storeId = getStoreId(req);
    const { username, password, full_name, email, phone_number, role = 'staff', is_active = true } = req.body;

    if (!username || !password || !full_name) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้, รหัสผ่าน และชื่อ-นามสกุลให้ครบถ้วน' });
    }

    if (password.length < 4) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 4 ตัวอักษร' });
    }

    await client.query('BEGIN');

    // Check store plan & slug for default email
    const storeRes = await client.query(`SELECT slug, plan_name FROM stores WHERE id = $1`, [storeId]);
    const planName = (storeRes.rows[0]?.plan_name || 'Professional').toLowerCase();
    if (planName.includes('starter')) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'แพ็กเกจ Starter ไม่รองรับการเพิ่มบัญชีพนักงานหลายคน กรุณาอัปเกรดเป็น Professional'
      });
    }

    const storeSlug = storeRes.rows[0]?.slug || 'store';
    const finalEmail = (email && email.trim()) ? email.trim() : `${username.trim()}@${storeSlug}.local`;

    // Check duplicate username or email in users
    const dupCheck = await client.query(
      `SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
      [username.trim(), finalEmail]
    );

    let userId;
    const targetRole = role === 'manager' ? 'manager' : 'staff';

    if (dupCheck.rows.length > 0) {
      // User exists in system, check if already in this store
      userId = dupCheck.rows[0].id;
      const storeUserCheck = await client.query(
        `SELECT id FROM store_users WHERE store_id = $1 AND user_id = $2`,
        [storeId, userId]
      );
      if (storeUserCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้หรืออีเมลนี้เป็นพนักงานในร้านนี้อยู่แล้ว' });
      }
      // Add existing user to store
      await client.query(
        `INSERT INTO store_users (store_id, user_id, role, is_active) VALUES ($1, $2, $3, $4)`,
        [storeId, userId, targetRole, is_active]
      );
    } else {
      // Create new user
      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (username, email, password_hash, full_name, phone_number, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, username, email, full_name, role`,
        [
          username.trim(),
          finalEmail,
          passwordHash,
          full_name.trim(),
          phone_number ? phone_number.trim() : '',
          targetRole,
          is_active
        ]
      );
      userId = userRes.rows[0].id;

      await client.query(
        `INSERT INTO store_users (store_id, user_id, role, is_active) VALUES ($1, $2, $3, $4)`,
        [storeId, userId, targetRole, is_active]
      );
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'เพิ่มพนักงานใหม่เรียบร้อยแล้ว ✨'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Admin createStaff Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างพนักงาน: ' + err.message });
  } finally {
    client.release();
  }
}

async function updateStaff(req, res) {
  const client = await getClient();
  try {
    const storeId = getStoreId(req);
    const targetUserId = parseInt(req.params.id, 10);
    const { full_name, email, phone_number, role, is_active, password } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    await client.query('BEGIN');

    // Verify user belongs to this store
    const suRes = await client.query(
      `SELECT * FROM store_users WHERE store_id = $1 AND user_id = $2`,
      [storeId, targetUserId]
    );
    if (suRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงานในร้านนี้' });
    }

    // Update store_users
    const targetRole = role === 'manager' ? 'manager' : (role === 'staff' ? 'staff' : suRes.rows[0].role);
    const targetActive = is_active !== undefined ? Boolean(is_active) : suRes.rows[0].is_active;

    await client.query(
      `UPDATE store_users SET role = $1, is_active = $2 WHERE store_id = $3 AND user_id = $4`,
      [targetRole, targetActive, storeId, targetUserId]
    );

    // Update users table
    let updateUserSql = `UPDATE users SET full_name = COALESCE($1, full_name), phone_number = COALESCE($2, phone_number), email = COALESCE($3, email), is_active = COALESCE($4, is_active), updated_at = CURRENT_TIMESTAMP`;
    const params = [
      full_name ? full_name.trim() : null,
      phone_number !== undefined ? phone_number.trim() : null,
      email ? email.trim() : null,
      targetActive
    ];

    if (password && password.trim().length >= 4) {
      const passwordHash = await bcrypt.hash(password.trim(), 10);
      updateUserSql += `, password_hash = $5`;
      params.push(passwordHash);
      updateUserSql += ` WHERE id = $6`;
      params.push(targetUserId);
    } else {
      updateUserSql += ` WHERE id = $5`;
      params.push(targetUserId);
    }

    await client.query(updateUserSql, params);

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'อัปเดตข้อมูลพนักงานเรียบร้อยแล้ว ✨'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Admin updateStaff Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตข้อมูล: ' + err.message });
  } finally {
    client.release();
  }
}

async function deleteStaff(req, res) {
  const client = await getClient();
  try {
    const storeId = getStoreId(req);
    const targetUserId = parseInt(req.params.id, 10);

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    // Prevent deleting self
    if (req.user && req.user.id === targetUserId) {
      return res.status(400).json({ success: false, message: 'ไม่สามารถลบบัญชีของตนเองที่กำลังใช้งานอยู่ได้' });
    }

    await client.query('BEGIN');

    // Remove from store_users
    const delSuRes = await client.query(
      `DELETE FROM store_users WHERE store_id = $1 AND user_id = $2 RETURNING *`,
      [storeId, targetUserId]
    );

    if (delSuRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบพนักงานนี้ในร้าน' });
    }

    // If user is not associated with any other stores and is not super admin, delete from users
    const otherStores = await client.query(
      `SELECT COUNT(*) as count FROM store_users WHERE user_id = $1`,
      [targetUserId]
    );

    const userRes = await client.query(`SELECT role FROM users WHERE id = $1`, [targetUserId]);
    if (userRes.rows.length > 0 && userRes.rows[0].role !== 'admin' && parseInt(otherStores.rows[0].count, 10) === 0) {
      try {
        await client.query(`DELETE FROM users WHERE id = $1`, [targetUserId]);
      } catch (e) {
        await client.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [targetUserId]);
      }
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'ลบพนักงานออกจากร้านค้าเรียบร้อยแล้ว'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Admin deleteStaff Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบพนักงาน' });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// Realtime Order & Service Sync Fallback (Smart Polling)
// -------------------------------------------------------------
async function getLatestOrdersSync(req, res) {
  try {
    const storeId = getStoreId(req);

    // Get latest active order
    const latestOrderRes = await query(
      `SELECT o.id, o.order_number, o.table_id, o.customer_name, o.net_amount, o.status, o.created_at,
              t.table_number, t.is_takeaway
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.store_id = $1 AND o.status = 'active'
       ORDER BY o.id DESC LIMIT 1`,
      [storeId]
    );

    // Get kitchen pending count
    const kitchenCountRes = await query(
      `SELECT COUNT(oi.id) as pending_dishes
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.store_id = $1 AND oi.status = 'pending'`,
      [storeId]
    );

    // Get latest pending service call
    const serviceCallRes = await query(
      `SELECT sc.id, sc.table_id, sc.call_type, sc.created_at, t.table_number
       FROM service_calls sc
       LEFT JOIN restaurant_tables t ON t.id = sc.table_id
       WHERE sc.store_id = $1 AND sc.status = 'pending'
       ORDER BY sc.id DESC LIMIT 1`,
      [storeId]
    );

    let recentItems = [];
    if (latestOrderRes.rows.length > 0) {
      const itemsRes = await query(
        `SELECT oi.id, oi.menu_name, oi.quantity, oi.unit_price, oi.total_price, oi.special_notes,
                COALESCE(json_agg(json_build_object('name', oio.option_name, 'extra_price', oio.extra_price)) FILTER (WHERE oio.id IS NOT NULL), '[]') as options
         FROM order_items oi
         LEFT JOIN order_item_options oio ON oio.order_item_id = oi.id
         WHERE oi.order_id = $1
         GROUP BY oi.id
         ORDER BY oi.id ASC`,
        [latestOrderRes.rows[0].id]
      );
      recentItems = itemsRes.rows;
    }

    return res.json({
      success: true,
      latestOrder: latestOrderRes.rows[0] ? {
        ...latestOrderRes.rows[0],
        items: recentItems,
      } : null,
      pendingKitchenCount: parseInt(kitchenCountRes.rows[0]?.pending_dishes || 0, 10),
      latestServiceCall: serviceCallRes.rows[0] || null,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Admin getLatestOrdersSync Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตรวจสอบออเดอร์' });
  }
}

module.exports = {
  getDashboardMetrics,
  getTables,
  createTable,
  updateTable,
  deleteTable,
  getZones,
  createZone,
  updateZone,
  deleteZone,
  getKitchenOrders,
  updateKitchenItemStatus,
  getTableBill,
  checkoutOrder,
  getMenus,
  toggleMenuAvailability,
  createMenu,
  updateMenu,
  deleteMenu,
  getReports,
  updateTransaction,
  deleteTransaction,
  getSettings,
  updateSettings,
  toggleStoreOpen,
  testTelegram,
  simulateTelegramCallback,
  clearTelegramSimulation,
  getStaffList,
  createStaff,
  updateStaff,
  deleteStaff,
  getLatestOrdersSync,
};

