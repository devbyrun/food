const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, getClient } = require('../db');

// -------------------------------------------------------------
// 1. Platform Overview (Stats, Stores, Users)
// -------------------------------------------------------------
async function getPlatformOverview(req, res) {
  try {
    const storesCount = await query(`SELECT COUNT(*) as count FROM stores`);
    const usersCount = await query(`SELECT COUNT(*) as count FROM users`);
    const customersCount = await query(`
      SELECT 
        COALESCE(SUM(customer_count), COUNT(*)) as total_customers,
        COUNT(*) as total_sessions
      FROM orders
    `);
    const ordersCount = await query(`
      SELECT COUNT(*) as count, COALESCE(SUM(net_amount), 0) as total_volume 
      FROM orders 
      WHERE payment_status = 'paid'
    `);
    const trialStoresCount = await query(`
      SELECT COUNT(*) as count 
      FROM stores 
      WHERE trial_ends_at >= NOW() AND status != 'suspended'
    `);

    const storesList = await query(
      `SELECT s.*, 
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (COALESCE(s.trial_ends_at, NOW()) - NOW())) / 86400))::int as trial_days_left,
              (SELECT COUNT(*) FROM restaurant_tables WHERE store_id = s.id AND is_active = TRUE) as table_count,
              (SELECT COUNT(*) FROM menus WHERE store_id = s.id) as menu_count,
              (SELECT COUNT(*) FROM orders WHERE store_id = s.id AND payment_status = 'paid') as paid_orders_count,
              (SELECT COALESCE(SUM(net_amount), 0) FROM orders WHERE store_id = s.id AND payment_status = 'paid') as revenue
       FROM stores s
       ORDER BY s.id ASC`
    );

    const usersList = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone_number, u.role, u.is_active, u.created_at,
              s.id as store_id, s.name as store_name, s.slug as store_slug, su.role as store_role
       FROM users u
       LEFT JOIN store_users su ON u.id = su.user_id
       LEFT JOIN stores s ON su.store_id = s.id
       ORDER BY u.id ASC`
    );

    return res.json({
      success: true,
      stats: {
        totalStores: parseInt(storesCount.rows[0].count, 10),
        trialStores: parseInt(trialStoresCount.rows[0].count, 10),
        totalUsers: parseInt(usersCount.rows[0].count, 10),
        totalCustomers: parseInt(customersCount.rows[0]?.total_customers || 0, 10),
        totalPaidOrders: parseInt(ordersCount.rows[0].count, 10),
        totalVolume: parseFloat(ordersCount.rows[0].total_volume || 0),
      },
      stores: storesList.rows,
      users: usersList.rows,
    });
  } catch (err) {
    console.error('[Platform getPlatformOverview Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลส่วนกลาง' });
  }
}

// -------------------------------------------------------------
// 2. Create Store (With optional initial Manager user)
// -------------------------------------------------------------
async function createStore(req, res) {
  const client = await getClient();
  try {
    const {
      store_code,
      name,
      slug,
      address,
      phone_number,
      promptpay_number,
      promptpay_name,
      plan_name,
      subscription_price,
      trial_days = 30,
      billing_cycle = 'monthly',
      status = 'active',
      manager_username,
      manager_password,
      manager_full_name,
      manager_email
    } = req.body;

    if (!store_code || !name || !slug) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสร้านค้า, ชื่อร้าน และ URL Slug ให้ครบถ้วน' });
    }

    await client.query('BEGIN');

    // Check duplicate slug or code
    const dupCheck = await client.query(
      `SELECT id FROM stores WHERE store_code = $1 OR slug = $2 LIMIT 1`,
      [store_code.trim(), slug.trim().toLowerCase()]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'รหัสร้านค้า (Store Code) หรือ URL Slug นี้มีอยู่ในระบบแล้ว' });
    }

    const price = subscription_price !== undefined ? parseFloat(subscription_price) : (plan_name === 'Enterprise' ? 990 : 490);
    const plan = plan_name || 'Professional';
    const logoUrl = req.body.logo_url || null;

    // Insert store
    const storeRes = await client.query(
      `INSERT INTO stores (
        store_code, name, slug, logo_url, address, phone_number, promptpay_number, promptpay_name,
        plan_name, subscription_price, trial_ends_at, billing_cycle, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP + ($11 || ' days')::interval, $12, $13)
      RETURNING *`,
      [
        store_code.trim(),
        name.trim(),
        slug.trim().toLowerCase(),
        logoUrl,
        address || '',
        phone_number || '',
        promptpay_number || '',
        promptpay_name || '',
        plan,
        price,
        parseInt(trial_days, 10) || 30,
        billing_cycle,
        status
      ]
    );

    const newStore = storeRes.rows[0];

    // Create default starter Table Zone and Table
    const zoneRes = await client.query(
      `INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, 1) RETURNING id`,
      [newStore.id, 'โซนทั่วไป (Main Hall)']
    );
    const zoneId = zoneRes.rows[0].id;

    const qrTokenT1 = `${newStore.slug}-t01-${Math.random().toString(36).substring(2, 6)}`;
    await client.query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status)
       VALUES ($1, $2, 'T-01', 4, $3, 'available')`,
      [newStore.id, zoneId, qrTokenT1]
    );

    // Create default Takeaway Table (กลับบ้าน)
    const qrTokenTakeaway = `${newStore.slug}-takeaway-${Math.random().toString(36).substring(2, 7)}`;
    await client.query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
       VALUES ($1, NULL, 'กลับบ้าน', 0, $2, 'available', TRUE)`,
      [newStore.id, qrTokenTakeaway]
    );

    // Create default category
    await client.query(
      `INSERT INTO categories (store_id, name, sort_order) VALUES ($1, 'เมนูแนะนำ (Recommended)', 1)`,
      [newStore.id]
    );

    // Create manager user if provided
    let createdUser = null;
    if (manager_username && manager_password) {
      const userDup = await client.query(
        `SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
        [manager_username.trim(), (manager_email || `${manager_username}@${slug}.com`).trim()]
      );

      if (userDup.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้ (Username) หรืออีเมลนี้มีอยู่ในระบบแล้ว' });
      }

      const passwordHash = await bcrypt.hash(manager_password, 10);
      const userRes = await client.query(
        `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
         VALUES ($1, $2, $3, $4, $5, 'manager')
         RETURNING id, username, email, full_name, role`,
        [
          manager_username.trim(),
          (manager_email || `${manager_username}@${slug}.com`).trim(),
          passwordHash,
          manager_full_name || `ผู้จัดการ ${name}`,
          phone_number || ''
        ]
      );
      createdUser = userRes.rows[0];

      await client.query(
        `INSERT INTO store_users (store_id, user_id, role) VALUES ($1, $2, 'manager')`,
        [newStore.id, createdUser.id]
      );
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'สร้างร้านค้าใหม่และตั้งค่าเริ่มต้นเรียบร้อยแล้ว ✨',
      store: newStore,
      manager: createdUser,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Platform createStore Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างร้านค้า: ' + err.message });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// 3. Update Store (Details, Plan, Trial, Status)
// -------------------------------------------------------------
async function updateStore(req, res) {
  try {
    const storeId = parseInt(req.params.id, 10);
    const {
      name,
      store_code,
      slug,
      address,
      phone_number,
      promptpay_number,
      promptpay_name,
      plan_name,
      subscription_price,
      billing_cycle,
      status,
      trial_ends_at,
      extend_trial_days,
      vat_rate,
      service_charge,
      logo_url,
      manager_password
    } = req.body;

    // Check slug duplication if changing slug
    if (slug) {
      const slugDup = await query(
        `SELECT id FROM stores WHERE slug = $1 AND id != $2`,
        [slug.trim().toLowerCase(), storeId]
      );
      if (slugDup.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'URL Slug นี้ถูกใช้งานแล้ว กรุณาตั้งค่าอื่น' });
      }
    }

    let updateSql = `
      UPDATE stores
      SET name = COALESCE($1, name),
          store_code = COALESCE($2, store_code),
          slug = COALESCE($3, slug),
          address = COALESCE($4, address),
          phone_number = COALESCE($5, phone_number),
          promptpay_number = COALESCE($6, promptpay_number),
          promptpay_name = COALESCE($7, promptpay_name),
          plan_name = COALESCE($8, plan_name),
          subscription_price = COALESCE($9, subscription_price),
          billing_cycle = COALESCE($10, billing_cycle),
          status = COALESCE($11, status),
          vat_rate = COALESCE($12, vat_rate),
          service_charge = COALESCE($13, service_charge),
          logo_url = COALESCE($14, logo_url),
          updated_at = CURRENT_TIMESTAMP
    `;

    const params = [
      name ? name.trim() : null,
      store_code ? store_code.trim() : null,
      slug ? slug.trim().toLowerCase() : null,
      address !== undefined ? address : null,
      phone_number !== undefined ? phone_number.trim() : null,
      promptpay_number !== undefined ? promptpay_number.trim() : null,
      promptpay_name !== undefined ? promptpay_name.trim() : null,
      plan_name || null,
      subscription_price !== undefined ? parseFloat(subscription_price) : null,
      billing_cycle || null,
      status || null,
      vat_rate !== undefined ? parseFloat(vat_rate) : null,
      service_charge !== undefined ? parseFloat(service_charge) : null,
      logo_url !== undefined ? logo_url : null,
    ];

    let paramIdx = 15;
    if (extend_trial_days && parseInt(extend_trial_days, 10) > 0) {
      updateSql += `, trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + ($${paramIdx} || ' days')::interval`;
      params.push(parseInt(extend_trial_days, 10));
      paramIdx++;
    } else if (trial_ends_at) {
      updateSql += `, trial_ends_at = $${paramIdx}`;
      params.push(new Date(trial_ends_at));
      paramIdx++;
    }

    updateSql += ` WHERE id = $${paramIdx} RETURNING *`;
    params.push(storeId);

    const result = await query(updateSql, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบร้านค้านี้ในระบบ' });
    }

    // Reset manager password if provided
    if (manager_password && manager_password.trim().length >= 4) {
      const passwordHash = await bcrypt.hash(manager_password.trim(), 10);
      await query(
        `UPDATE users 
         SET password_hash = $1 
         WHERE id IN (
           SELECT user_id FROM store_users WHERE store_id = $2 AND role = 'manager'
         )`,
        [passwordHash, storeId]
      );
    }

    return res.json({
      success: true,
      message: 'อัปเดตข้อมูลร้านค้าเรียบร้อยแล้ว',
      store: result.rows[0],
    });
  } catch (err) {
    console.error('[Platform updateStore Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตร้านค้า: ' + err.message });
  }
}

// -------------------------------------------------------------
// 3.1 Delete Store (Cascade Deletion of all Store Data)
// -------------------------------------------------------------
async function deleteStore(req, res) {
  const client = await getClient();
  try {
    const storeId = parseInt(req.params.id, 10);
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'Invalid store ID' });
    }

    const storeCheck = await client.query(`SELECT id, name FROM stores WHERE id = $1`, [storeId]);
    if (storeCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบร้านค้านี้ในระบบ' });
    }
    const storeName = storeCheck.rows[0].name;

    await client.query('BEGIN');

    // 1. Identify users that belong exclusively to this store and are not platform Super Admins
    const exclusiveUsersRes = await client.query(
      `SELECT u.id 
       FROM users u
       JOIN store_users su ON u.id = su.user_id
       WHERE su.store_id = $1 
         AND u.role != 'admin'
         AND NOT EXISTS (
           SELECT 1 FROM store_users su2 
           WHERE su2.user_id = u.id AND su2.store_id != $1
         )`,
      [storeId]
    );
    const exclusiveUserIds = exclusiveUsersRes.rows.map(r => r.id);

    // 2. Delete service calls
    await client.query(`DELETE FROM service_calls WHERE store_id = $1`, [storeId]);

    // 3. Delete order item options
    await client.query(
      `DELETE FROM order_item_options 
       WHERE order_item_id IN (
         SELECT oi.id 
         FROM order_items oi 
         JOIN orders o ON oi.order_id = o.id 
         WHERE o.store_id = $1
       )`,
      [storeId]
    );

    // 4. Delete order items
    await client.query(
      `DELETE FROM order_items 
       WHERE order_id IN (
         SELECT id FROM orders WHERE store_id = $1
       )`,
      [storeId]
    );

    // 5. Delete payments
    await client.query(`DELETE FROM payments WHERE store_id = $1`, [storeId]);

    // 6. Delete orders
    await client.query(`DELETE FROM orders WHERE store_id = $1`, [storeId]);

    // 7. Delete restaurant tables
    await client.query(`DELETE FROM restaurant_tables WHERE store_id = $1`, [storeId]);

    // 8. Delete table zones
    await client.query(`DELETE FROM table_zones WHERE store_id = $1`, [storeId]);

    // 9. Delete menu option group relations
    await client.query(
      `DELETE FROM menu_option_groups 
       WHERE menu_id IN (
         SELECT id FROM menus WHERE store_id = $1
       )`,
      [storeId]
    );

    // 10. Delete option items
    await client.query(
      `DELETE FROM option_items 
       WHERE group_id IN (
         SELECT id FROM option_groups WHERE store_id = $1
       )`,
      [storeId]
    );

    // 11. Delete option groups
    await client.query(`DELETE FROM option_groups WHERE store_id = $1`, [storeId]);

    // 12. Delete menus
    await client.query(`DELETE FROM menus WHERE store_id = $1`, [storeId]);

    // 13. Delete categories
    await client.query(`DELETE FROM categories WHERE store_id = $1`, [storeId]);

    // 14. Delete store_users associations
    await client.query(`DELETE FROM store_users WHERE store_id = $1`, [storeId]);

    // 15. Delete exclusive store users from users table
    if (exclusiveUserIds.length > 0) {
      await client.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [exclusiveUserIds]);
    }

    // 16. Delete store itself
    await client.query(`DELETE FROM stores WHERE id = $1`, [storeId]);

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: `ลบร้านค้า "${storeName}" และข้อมูลที่เกี่ยวข้องทั้งหมดเรียบร้อยแล้ว ✨`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Platform deleteStore Error]:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'เกิดข้อผิดพลาดในการลบร้านค้า: ' + err.message 
    });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// 4. Sales Analytics (Daily, Monthly, Yearly)
// -------------------------------------------------------------
async function getSalesAnalytics(req, res) {
  try {
    const { period = 'daily', store_id, year, month, date } = req.query;

    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const targetMonth = parseInt(month, 10) || (new Date().getMonth() + 1);

    let storeFilter = '';
    const queryParams = [];

    if (store_id && store_id !== 'all') {
      queryParams.push(parseInt(store_id, 10));
      storeFilter = `AND o.store_id = $${queryParams.length}`;
    }

    // 1. Overall Period Metrics (Total Sales, Orders, AOV)
    let periodWhere = '';
    if (period === 'daily') {
      if (year && month) {
        queryParams.push(targetYear, targetMonth);
        periodWhere = `AND EXTRACT(YEAR FROM o.opened_at) = $${queryParams.length - 1} AND EXTRACT(MONTH FROM o.opened_at) = $${queryParams.length}`;
      } else {
        periodWhere = `AND o.opened_at >= CURRENT_DATE - INTERVAL '30 days'`;
      }
    } else if (period === 'monthly') {
      queryParams.push(targetYear);
      periodWhere = `AND EXTRACT(YEAR FROM o.opened_at) = $${queryParams.length}`;
    } else if (period === 'yearly') {
      periodWhere = ``;
    }

    const summaryRes = await query(
      `SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(o.net_amount), 0) as total_revenue,
        COALESCE(AVG(o.net_amount), 0) as avg_order_value,
        COALESCE(SUM(o.discount_amount), 0) as total_discount,
        COALESCE(SUM(o.service_amount), 0) as total_service_charge,
        COALESCE(SUM(o.vat_amount), 0) as total_vat
       FROM orders o
       WHERE o.payment_status = 'paid' ${storeFilter} ${periodWhere}`,
      queryParams
    );

    // 2. Time-series Breakdown Data
    let timeSeriesRes;
    if (period === 'daily') {
      timeSeriesRes = await query(
        `SELECT 
          TO_CHAR(o.opened_at, 'YYYY-MM-DD') as period_label,
          TO_CHAR(o.opened_at, 'DD/MM') as short_label,
          COUNT(*) as orders_count,
          COALESCE(SUM(o.net_amount), 0) as revenue
         FROM orders o
         WHERE o.payment_status = 'paid' ${storeFilter} ${periodWhere}
         GROUP BY TO_CHAR(o.opened_at, 'YYYY-MM-DD'), TO_CHAR(o.opened_at, 'DD/MM')
         ORDER BY period_label ASC`,
        queryParams
      );
    } else if (period === 'monthly') {
      timeSeriesRes = await query(
        `SELECT 
          TO_CHAR(o.opened_at, 'YYYY-MM') as period_label,
          TO_CHAR(o.opened_at, 'Mon') as short_label,
          COUNT(*) as orders_count,
          COALESCE(SUM(o.net_amount), 0) as revenue
         FROM orders o
         WHERE o.payment_status = 'paid' ${storeFilter} ${periodWhere}
         GROUP BY TO_CHAR(o.opened_at, 'YYYY-MM'), TO_CHAR(o.opened_at, 'Mon')
         ORDER BY period_label ASC`,
        queryParams
      );
    } else {
      timeSeriesRes = await query(
        `SELECT 
          TO_CHAR(o.opened_at, 'YYYY') as period_label,
          TO_CHAR(o.opened_at, 'YYYY') as short_label,
          COUNT(*) as orders_count,
          COALESCE(SUM(o.net_amount), 0) as revenue
         FROM orders o
         WHERE o.payment_status = 'paid' ${storeFilter}
         GROUP BY TO_CHAR(o.opened_at, 'YYYY')
         ORDER BY period_label ASC`,
        store_id && store_id !== 'all' ? [parseInt(store_id, 10)] : []
      );
    }

    // 3. Store-by-Store Breakdown
    const storeBreakdownRes = await query(
      `SELECT 
        s.id as store_id,
        s.name as store_name,
        s.store_code,
        s.plan_name,
        COUNT(o.id) as orders_count,
        COALESCE(SUM(o.net_amount), 0) as revenue
       FROM stores s
       LEFT JOIN orders o ON s.id = o.store_id AND o.payment_status = 'paid' ${periodWhere}
       GROUP BY s.id, s.name, s.store_code, s.plan_name
       ORDER BY revenue DESC`,
      queryParams
    );

    // 4. Payment Method Breakdown
    const paymentBreakdownRes = await query(
      `SELECT 
        COALESCE(p.payment_method, 'promptpay') as payment_method,
        COUNT(*) as count,
        COALESCE(SUM(p.amount_received), 0) as total_amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE o.payment_status = 'paid' ${storeFilter} ${periodWhere}
       GROUP BY p.payment_method`,
      queryParams
    );

    return res.json({
      success: true,
      period,
      filter: {
        store_id: store_id || 'all',
        year: targetYear,
        month: targetMonth,
      },
      summary: {
        totalOrders: parseInt(summaryRes.rows[0].total_orders, 10),
        totalRevenue: parseFloat(summaryRes.rows[0].total_revenue),
        avgOrderValue: parseFloat(summaryRes.rows[0].avg_order_value),
        totalDiscount: parseFloat(summaryRes.rows[0].total_discount),
        totalVat: parseFloat(summaryRes.rows[0].total_vat),
        totalServiceCharge: parseFloat(summaryRes.rows[0].total_service_charge),
      },
      timeSeries: timeSeriesRes.rows.map(r => ({
        label: r.period_label,
        shortLabel: r.short_label,
        orders: parseInt(r.orders_count, 10),
        revenue: parseFloat(r.revenue),
      })),
      storeBreakdown: storeBreakdownRes.rows.map(r => ({
        storeId: r.store_id,
        storeName: r.store_name,
        storeCode: r.store_code,
        planName: r.plan_name,
        orders: parseInt(r.orders_count, 10),
        revenue: parseFloat(r.revenue),
      })),
      paymentBreakdown: paymentBreakdownRes.rows.map(r => ({
        method: r.payment_method,
        count: parseInt(r.count, 10),
        amount: parseFloat(r.total_amount),
      })),
    });
  } catch (err) {
    console.error('[Platform getSalesAnalytics Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการคำนวณสถิติยอดขาย' });
  }
}

// -------------------------------------------------------------
// 5. Public 30-Day Free Trial Signup (Landing Page)
// -------------------------------------------------------------
async function trialSignup(req, res) {
  const client = await getClient();
  try {
    const {
      store_name,
      phone_number,
      manager_name,
      manager_email,
      manager_username,
      manager_password,
      plan_name = 'Professional'
    } = req.body;

    if (!store_name || !manager_name || !manager_username || !manager_password) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วนเพื่อเปิดร้านทดลองใช้ฟรี' });
    }

    await client.query('BEGIN');

    // Create unique slug & store code
    const rawSlug = store_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'shop';
    const randCode = Math.floor(1000 + Math.random() * 9000);
    const slug = `${rawSlug}-${randCode}`;
    const store_code = `ST-${randCode}`;

    // Check user uniqueness
    const userDup = await client.query(
      `SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
      [manager_username.trim(), (manager_email || `${manager_username}@tableqr.local`).trim()]
    );
    if (userDup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้หรืออีเมลนี้มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น' });
    }

    const price = plan_name === 'Enterprise' ? 990 : 490;

    // Insert Store with 30-Day Free Trial
    const storeRes = await client.query(
      `INSERT INTO stores (
        store_code, name, slug, phone_number, plan_name, subscription_price, 
        trial_ends_at, billing_cycle, status
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '30 days', 'monthly', 'active')
      RETURNING *`,
      [store_code, store_name.trim(), slug, phone_number || '', plan_name, price]
    );
    const newStore = storeRes.rows[0];

    // Create Initial Table Zone & 3 Sample Tables
    const zoneRes = await client.query(
      `INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, 'โซนหลัก', 1) RETURNING id`,
      [newStore.id]
    );
    const zoneId = zoneRes.rows[0].id;

    for (let i = 1; i <= 3; i++) {
      const pad = String(i).padStart(2, '0');
      const qrToken = `${slug}-t${pad}-${Math.random().toString(36).substring(2, 6)}`;
      await client.query(
        `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status)
         VALUES ($1, $2, $3, 4, $4, 'available')`,
        [newStore.id, zoneId, `T-${pad}`, qrToken]
      );
    }

    // Create Takeaway Table (กลับบ้าน)
    const qrTokenTakeaway = `${slug}-takeaway-${Math.random().toString(36).substring(2, 7)}`;
    await client.query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
       VALUES ($1, NULL, 'กลับบ้าน', 0, $2, 'available', TRUE)`,
      [newStore.id, qrTokenTakeaway]
    );

    // Create Sample Categories & Recommended Menus
    const catRes = await client.query(
      `INSERT INTO categories (store_id, name, sort_order) VALUES ($1, 'เมนูอาหารแนะนำ 🌟', 1) RETURNING id`,
      [newStore.id]
    );
    const catId = catRes.rows[0].id;

    await client.query(
      `INSERT INTO menus (store_id, category_id, name, description, price, is_available, is_recommend, sort_order)
       VALUES 
        ($1, $2, 'ข้าวกะเพราหมูกรอบไข่ดาว', 'หมูกรอบแท้สูตรเด็ด ผัดกะเพราพริกแห้งรสจัดจ้าน', 89.00, true, true, 1),
        ($1, $2, 'ต้มยำกุ้งน้ำข้น', 'กุ้งแม่น้ำสดๆ น้ำต้มยำสูตรเข้มข้นหอมเครื่องสมุนไพร', 180.00, true, true, 2),
        ($1, $2, 'ชามะนาวเย็น', 'ชาไทยสูตรหอมสดชื่น เปรี้ยวหวานลงตัว', 45.00, true, false, 3)`,
      [newStore.id, catId]
    );

    // Create Manager User (Role: manager - เจ้าของร้าน)
    const passwordHash = await bcrypt.hash(manager_password, 10);
    const userRes = await client.query(
      `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
       VALUES ($1, $2, $3, $4, $5, 'manager')
       RETURNING id, username, email, full_name, role`,
      [
        manager_username.trim(),
        (manager_email || `${manager_username}@tableqr.local`).trim(),
        passwordHash,
        manager_name.trim(),
        phone_number || ''
      ]
    );
    const newUser = userRes.rows[0];

    // Link Store User as Manager
    await client.query(
      `INSERT INTO store_users (store_id, user_id, role) VALUES ($1, $2, 'manager')`,
      [newStore.id, newUser.id]
    );

    await client.query('COMMIT');

    // Generate JWT Token for Auto-Login
    const token = jwt.sign(
      {
        userId: newUser.id,
        username: newUser.username,
        role: newUser.role,
        storeId: newStore.id,
        storeRole: 'manager',
        storeSlug: newStore.slug,
      },
      process.env.JWT_SECRET || 'super_secret_food_ordering_jwt_key_2026',
      { expiresIn: '7d' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

    return res.json({
      success: true,
      message: 'เปิดร้านค้าทดลองใช้งานฟรี 30 วันสำเร็จแล้ว! 🎉',
      token,
      store: newStore,
      user: newUser,
      redirectUrl: '/store.html',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Platform trialSignup Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสมัครทดลองใช้งาน: ' + err.message });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// 6. Platform User & Staff Management (Super Admin only)
// -------------------------------------------------------------
async function getPlatformUsers(req, res) {
  try {
    const usersRes = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone_number, u.role, u.is_active, u.created_at,
              s.id as store_id, s.name as store_name, s.slug as store_slug, s.store_code, su.role as store_role
       FROM users u
       LEFT JOIN store_users su ON u.id = su.user_id
       LEFT JOIN stores s ON su.store_id = s.id
       ORDER BY u.id ASC`
    );

    return res.json({
      success: true,
      users: usersRes.rows
    });
  } catch (err) {
    console.error('[Platform getPlatformUsers Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลผู้ใช้งาน' });
  }
}

async function createPlatformUser(req, res) {
  const client = await getClient();
  try {
    const {
      username,
      password,
      full_name,
      email,
      phone_number,
      role = 'staff',
      store_id,
      is_active = true
    } = req.body;

    if (!username || !password || !full_name) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้, รหัสผ่าน และชื่อ-นามสกุลให้ครบถ้วน' });
    }

    if (password.length < 4) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 4 ตัวอักษร' });
    }

    await client.query('BEGIN');

    const finalEmail = (email && email.trim()) ? email.trim() : `${username.trim()}@platform.local`;

    const dupCheck = await client.query(
      `SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
      [username.trim(), finalEmail]
    );

    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้ (Username) หรืออีเมลนี้มีอยู่ในระบบแล้ว' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const globalRole = (role === 'admin') ? 'admin' : (role === 'manager' ? 'manager' : 'staff');

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
        globalRole,
        is_active
      ]
    );
    const newUser = userRes.rows[0];

    // If store_id provided and not super admin, link to store
    if (store_id && store_id !== 'none' && store_id !== '' && globalRole !== 'admin') {
      const targetStoreId = parseInt(store_id, 10);
      const storeRole = role === 'manager' ? 'manager' : 'staff';
      await client.query(
        `INSERT INTO store_users (store_id, user_id, role, is_active) VALUES ($1, $2, $3, $4)`,
        [targetStoreId, newUser.id, storeRole, is_active]
      );
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'สร้างบัญชีผู้ใช้งานใหม่เรียบร้อยแล้ว ✨',
      user: newUser
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Platform createPlatformUser Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างผู้ใช้: ' + err.message });
  } finally {
    client.release();
  }
}

async function updatePlatformUser(req, res) {
  const client = await getClient();
  try {
    const targetUserId = parseInt(req.params.id, 10);
    const {
      full_name,
      email,
      phone_number,
      role,
      store_id,
      is_active,
      password
    } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    await client.query('BEGIN');

    const userRes = await client.query(`SELECT * FROM users WHERE id = $1`, [targetUserId]);
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้นี้ในระบบ' });
    }

    const targetActive = is_active !== undefined ? Boolean(is_active) : userRes.rows[0].is_active;
    const targetRole = role || userRes.rows[0].role;

    // Update users table
    let updateUserSql = `UPDATE users SET full_name = COALESCE($1, full_name), email = COALESCE($2, email), phone_number = COALESCE($3, phone_number), role = COALESCE($4, role), is_active = COALESCE($5, is_active), updated_at = CURRENT_TIMESTAMP`;
    const params = [
      full_name ? full_name.trim() : null,
      email ? email.trim() : null,
      phone_number !== undefined ? phone_number.trim() : null,
      targetRole,
      targetActive
    ];

    if (password && password.trim().length >= 4) {
      const passwordHash = await bcrypt.hash(password.trim(), 10);
      updateUserSql += `, password_hash = $6`;
      params.push(passwordHash);
      updateUserSql += ` WHERE id = $7 RETURNING *`;
      params.push(targetUserId);
    } else {
      updateUserSql += ` WHERE id = $6 RETURNING *`;
      params.push(targetUserId);
    }

    const updatedUserRes = await client.query(updateUserSql, params);

    // Manage store_users relationship
    if (targetRole === 'admin') {
      // Remove any store_users association for super admin
      await client.query(`DELETE FROM store_users WHERE user_id = $1`, [targetUserId]);
    } else if (store_id !== undefined) {
      await client.query(`DELETE FROM store_users WHERE user_id = $1`, [targetUserId]);
      if (store_id && store_id !== 'none' && store_id !== '') {
        const targetStoreId = parseInt(store_id, 10);
        const storeRole = targetRole === 'manager' ? 'manager' : 'staff';
        await client.query(
          `INSERT INTO store_users (store_id, user_id, role, is_active) VALUES ($1, $2, $3, $4)`,
          [targetStoreId, targetUserId, storeRole, targetActive]
        );
      }
    } else {
      // Update is_active in store_users if exists
      await client.query(`UPDATE store_users SET is_active = $1 WHERE user_id = $2`, [targetActive, targetUserId]);
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'อัปเดตข้อมูลผู้ใช้งานเรียบร้อยแล้ว ✨',
      user: updatedUserRes.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Platform updatePlatformUser Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตข้อมูล: ' + err.message });
  } finally {
    client.release();
  }
}

async function deletePlatformUser(req, res) {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    if (req.user && req.user.id === targetUserId) {
      return res.status(400).json({ success: false, message: 'ไม่สามารถลบบัญชี Super Admin ของตนเองที่กำลังใช้งานอยู่ได้' });
    }

    // Check if user exists
    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [targetUserId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งานนี้ในระบบ' });
    }

    try {
      await query(`DELETE FROM users WHERE id = $1`, [targetUserId]);
    } catch (e) {
      // If foreign key constraint (e.g. from payments.received_by), mark as inactive instead
      await query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [targetUserId]);
      await query(`DELETE FROM store_users WHERE user_id = $1`, [targetUserId]);
    }

    return res.json({
      success: true,
      message: 'ลบผู้ใช้งานออกจากระบบเรียบร้อยแล้ว'
    });
  } catch (err) {
    console.error('[Platform deletePlatformUser Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบผู้ใช้งาน' });
  }
}

// -------------------------------------------------------------
// 7. Subscription Plans Management (Public & Super Admin)
// -------------------------------------------------------------
async function getSubscriptionPlans(req, res) {
  try {
    const plansRes = await query(
      `SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC`
    );
    return res.json({
      success: true,
      plans: plansRes.rows
    });
  } catch (err) {
    console.error('[Platform getSubscriptionPlans Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดแพ็กเกจราคา' });
  }
}

async function getAllSubscriptionPlansAdmin(req, res) {
  try {
    const plansRes = await query(
      `SELECT * FROM subscription_plans ORDER BY sort_order ASC, id ASC`
    );
    return res.json({
      success: true,
      plans: plansRes.rows
    });
  } catch (err) {
    console.error('[Platform getAllSubscriptionPlansAdmin Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการโหลดแพ็กเกจราคา' });
  }
}

async function createSubscriptionPlan(req, res) {
  try {
    const {
      code,
      name,
      subtitle,
      price_monthly,
      price_yearly,
      features,
      disabled_features,
      is_featured,
      badge_text,
      sort_order,
      is_active
    } = req.body;

    if (!code || !name) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสแพ็กเกจ (Code) และชื่อแพ็กเกจ' });
    }

    const dupCheck = await query(`SELECT id FROM subscription_plans WHERE code = $1`, [code.trim().toLowerCase()]);
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'รหัสแพ็กเกจ (Code) นี้มีอยู่ในระบบแล้ว' });
    }

    const insertRes = await query(
      `INSERT INTO subscription_plans (
        code, name, subtitle, price_monthly, price_yearly, 
        features, disabled_features, is_featured, badge_text, sort_order, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
      RETURNING *`,
      [
        code.trim().toLowerCase(),
        name.trim(),
        subtitle || '',
        parseFloat(price_monthly || 0),
        parseFloat(price_yearly || 0),
        JSON.stringify(Array.isArray(features) ? features : []),
        JSON.stringify(Array.isArray(disabled_features) ? disabled_features : []),
        !!is_featured,
        badge_text || null,
        parseInt(sort_order || 0, 10),
        is_active !== undefined ? !!is_active : true
      ]
    );

    return res.json({
      success: true,
      message: 'เพิ่มแพ็กเกจราคาใหม่เรียบร้อยแล้ว ✨',
      plan: insertRes.rows[0]
    });
  } catch (err) {
    console.error('[Platform createSubscriptionPlan Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างแพ็กเกจ: ' + err.message });
  }
}

async function updateSubscriptionPlan(req, res) {
  try {
    const planId = parseInt(req.params.id, 10);
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Invalid plan ID' });
    }

    const {
      name,
      subtitle,
      price_monthly,
      price_yearly,
      features,
      disabled_features,
      is_featured,
      badge_text,
      sort_order,
      is_active
    } = req.body;

    const currentRes = await query(`SELECT * FROM subscription_plans WHERE id = $1`, [planId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบแพ็กเกจนี้ในระบบ' });
    }

    const updateRes = await query(
      `UPDATE subscription_plans
       SET name = COALESCE($1, name),
           subtitle = COALESCE($2, subtitle),
           price_monthly = COALESCE($3, price_monthly),
           price_yearly = COALESCE($4, price_yearly),
           features = COALESCE($5::jsonb, features),
           disabled_features = COALESCE($6::jsonb, disabled_features),
           is_featured = COALESCE($7, is_featured),
           badge_text = $8,
           sort_order = COALESCE($9, sort_order),
           is_active = COALESCE($10, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *`,
      [
        name ? name.trim() : null,
        subtitle !== undefined ? subtitle.trim() : null,
        price_monthly !== undefined ? parseFloat(price_monthly) : null,
        price_yearly !== undefined ? parseFloat(price_yearly) : null,
        features !== undefined ? JSON.stringify(Array.isArray(features) ? features : []) : null,
        disabled_features !== undefined ? JSON.stringify(Array.isArray(disabled_features) ? disabled_features : []) : null,
        is_featured !== undefined ? !!is_featured : null,
        badge_text !== undefined ? badge_text : null,
        sort_order !== undefined ? parseInt(sort_order, 10) : null,
        is_active !== undefined ? !!is_active : null,
        planId
      ]
    );

    return res.json({
      success: true,
      message: 'บันทึกการแก้ไขแพ็กเกจเรียบร้อยแล้ว ✨',
      plan: updateRes.rows[0]
    });
  } catch (err) {
    console.error('[Platform updateSubscriptionPlan Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการแก้ไขแพ็กเกจ: ' + err.message });
  }
}

async function deleteSubscriptionPlan(req, res) {
  try {
    const planId = parseInt(req.params.id, 10);
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Invalid plan ID' });
    }

    await query(`DELETE FROM subscription_plans WHERE id = $1`, [planId]);

    return res.json({
      success: true,
      message: 'ลบแพ็กเกจออกจากระบบเรียบร้อยแล้ว'
    });
  } catch (err) {
    console.error('[Platform deleteSubscriptionPlan Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบแพ็กเกจ' });
  }
}

module.exports = {
  getPlatformOverview,
  createStore,
  updateStore,
  deleteStore,
  getSalesAnalytics,
  trialSignup,
  getPlatformUsers,
  createPlatformUser,
  updatePlatformUser,
  deletePlatformUser,
  getSubscriptionPlans,
  getAllSubscriptionPlansAdmin,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  deleteSubscriptionPlan,
};


