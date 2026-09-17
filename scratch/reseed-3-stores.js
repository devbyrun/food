const bcrypt = require('bcryptjs');
const { query, initDatabase } = require('../src/db');

async function reseedThreeStores() {
  console.log('[Reseed] Initializing database...');
  await initDatabase();

  console.log('[Reseed] Clearing old stores and non-admin users...');
  // Delete all orders, menus, stores, etc. via deleting stores
  await query('DELETE FROM stores');
  await query("DELETE FROM users WHERE role != 'admin'");

  const salt = await bcrypt.genSalt(10);
  const adminPasswordHash = await bcrypt.hash('admin123', salt);
  const pass123Hash = await bcrypt.hash('password123', salt);
  const managerPasswordHash = await bcrypt.hash('manager123', salt);
  const staffPasswordHash = await bcrypt.hash('staff123', salt);

  // Ensure superadmin exists
  const adminCheck = await query("SELECT id FROM users WHERE username = 'admin'");
  let adminId;
  if (adminCheck.rows.length === 0) {
    const adminUser = await query(
      `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ['admin', 'admin@foodqr.com', adminPasswordHash, 'ผู้ดูแลระบบสูงสุด (Super Admin)', '080-000-0001', 'admin']
    );
    adminId = adminUser.rows[0].id;
  } else {
    adminId = adminCheck.rows[0].id;
  }

  // 1. Create Users for the 3 Stores
  console.log('[Reseed] Creating store manager & staff users...');
  
  // Starter Manager
  const starterMgr = await query(
    `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['starter_mgr', 'cafe@starter.com', pass123Hash, 'คุณมานะ เจ้าของมินิคาเฟ่ (Starter)', '081-111-2233', 'manager']
  );
  const starterMgrId = starterMgr.rows[0].id;

  // Pro Manager & Staff
  const proMgr = await query(
    `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['manager', 'manager@somtumzaab.com', managerPasswordHash, 'สมชาย ผู้จัดการร้านแซ่บ (Professional)', '081-234-5678', 'manager']
  );
  const proMgrId = proMgr.rows[0].id;

  const proStaff = await query(
    `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['staff', 'staff@somtumzaab.com', staffPasswordHash, 'สมหญิง พนักงานบริการ & ครัว', '089-876-5432', 'staff']
  );
  const proStaffId = proStaff.rows[0].id;

  // Enterprise Manager
  const entMgr = await query(
    `INSERT INTO users (username, email, password_hash, full_name, phone_number, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    ['enterprise_mgr', 'buffet@enterprise.com', pass123Hash, 'คุณอัครเดช เจ้าของแกรนด์บุฟเฟต์ (Enterprise)', '089-999-8877', 'manager']
  );
  const entMgrId = entMgr.rows[0].id;

  // -------------------------------------------------------------
  // STORE 1: Starter Plan (Mini Cafe)
  // -------------------------------------------------------------
  console.log('[Reseed] Creating Store 1: Starter Plan...');
  const s1 = await query(
    `INSERT INTO stores (
      store_code, name, slug, logo_url, banner_url, address, phone_number,
      promptpay_number, promptpay_name, vat_rate, service_charge,
      plan_name, subscription_price, trial_ends_at, billing_cycle,
      is_open, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '30 days', 'monthly', true, 'active')
    RETURNING id`,
    [
      'ST-STARTER',
      '☕ มินิคาเฟ่ & คอฟฟี่บาร์ (Mini Cafe)',
      'mini-cafe',
      '☕',
      'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=1200&h=400&fit=crop',
      '88 ซอยอารีย์สัมพันธ์ แขวงพญาไท เขตพญาไท กรุงเทพฯ 10400',
      '081-111-2233',
      '0811112233',
      'มินิคาเฟ่ แอนด์ คอฟฟี่บาร์',
      0.00,
      0.00,
      'Starter',
      290.00
    ]
  );
  const s1Id = s1.rows[0].id;

  await query('INSERT INTO store_users (store_id, user_id, role) VALUES ($1, $2, $3)', [s1Id, starterMgrId, 'manager']);

  // Starter Zones & Tables
  const zCafe = await query('INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [s1Id, 'โซนคาเฟ่', 1]);
  const s1Tables = [
    { num: 'กลับบ้าน', cap: 0, token: 'cafe-takeaway', isTakeaway: true },
    { num: 'C-01', cap: 2, token: 'cafe-c01', isTakeaway: false },
    { num: 'C-02', cap: 2, token: 'cafe-c02', isTakeaway: false },
    { num: 'C-03', cap: 4, token: 'cafe-c03', isTakeaway: false },
    { num: 'C-04', cap: 4, token: 'cafe-c04', isTakeaway: false }
  ];
  for (const t of s1Tables) {
    await query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
       VALUES ($1, $2, $3, $4, $5, 'available', $6)`,
      [s1Id, t.isTakeaway ? null : zCafe.rows[0].id, t.num, t.cap, t.token, t.isTakeaway]
    );
  }

  // Starter Categories & Menus
  const catCoffee = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 1) RETURNING id', [s1Id, 'กาแฟสด & เครื่องดื่ม', '☕']);
  const catBakery = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 2) RETURNING id', [s1Id, 'เบเกอรี่ & ของหวาน', '🥐']);

  await query(`
    INSERT INTO menus (store_id, category_id, name, description, price, is_available, is_recommend, sort_order)
    VALUES 
    ($1, $2, 'เอสเปรสโซ่ ร้อน (Espresso)', 'กาแฟเข้มข้น หอมกรุ่น คั่วสดใหม่', 60, true, true, 1),
    ($1, $2, 'อเมริกาโน่ เย็น (Iced Americano)', 'ช็อตเอสเปรสโซ่ ผสมน้ำเย็น คั่วกลาง สดชื่น', 70, true, true, 2),
    ($1, $2, 'ลาเต้ เย็น (Iced Caffe Latte)', 'กาแฟหอมนุ่ม ผสมนมสดแท้ 100%', 80, true, true, 3),
    ($1, $2, 'ชาไทยพรีเมียม (Thai Tea)', 'ชาไทยใบชาคัดพิเศษ หอมหวานมันกำลังดี', 65, true, false, 4),
    ($1, $3, 'ครัวซองต์เนยสดฝรั่งเศส (Butter Croissant)', 'แป้งกรอบนอกนุ่มใน หอมเนยแท้ AOP', 85, true, true, 1),
    ($1, $3, 'ดาร์กช็อกโกแลตบราวนี่ (Dark Brownie)', 'ช็อกโกแลตเข้มข้น 70% หนึบฉ่ำ', 75, true, false, 2)
  `, [s1Id, catCoffee.rows[0].id, catBakery.rows[0].id]);

  // -------------------------------------------------------------
  // STORE 2: Professional Plan (Somtum Zaab)
  // -------------------------------------------------------------
  console.log('[Reseed] Creating Store 2: Professional Plan...');
  const s2 = await query(
    `INSERT INTO stores (
      store_code, name, slug, logo_url, banner_url, address, phone_number,
      promptpay_number, promptpay_name, vat_rate, service_charge,
      plan_name, subscription_price, trial_ends_at, billing_cycle,
      is_open, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '30 days', 'monthly', true, 'active')
    RETURNING id`,
    [
      'ST-PRO',
      '🍲 ส้มตำแซ่บนัว & ครัวไทย (Somtum Zaab)',
      'somtum-zaab',
      '🍲',
      'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=1200&h=400&fit=crop',
      '123 ถนนสุขุมวิท ซอย 55 (ทองหล่อ) แขวงคลองตันเหนือ เขตวัฒนา กรุงเทพฯ 10110',
      '081-234-5678',
      '0812345678',
      'บจก. ส้มตำแซ่บนัว จำกัด',
      7.00,
      10.00,
      'Professional',
      490.00
    ]
  );
  const s2Id = s2.rows[0].id;

  await query(
    'INSERT INTO store_users (store_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)',
    [s2Id, proMgrId, 'manager', proStaffId, 'staff']
  );

  const zAir = await query('INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [s2Id, 'โซนห้องแอร์', 1]);
  const zGarden = await query('INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [s2Id, 'โซนลานสวน', 2]);
  const zVIP = await query('INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [s2Id, 'โซนห้องรับรองพิเศษ', 3]);

  const s2Tables = [
    { num: 'กลับบ้าน', cap: 0, token: 'zaab-takeaway', isTakeaway: true },
    { num: 'T-01', cap: 4, token: 'zaab-t01', isTakeaway: false, zoneId: zAir.rows[0].id },
    { num: 'T-02', cap: 4, token: 'zaab-t02', isTakeaway: false, zoneId: zAir.rows[0].id },
    { num: 'T-03', cap: 2, token: 'zaab-t03', isTakeaway: false, zoneId: zAir.rows[0].id },
    { num: 'T-04', cap: 6, token: 'zaab-t04', isTakeaway: false, zoneId: zAir.rows[0].id },
    { num: 'T-05', cap: 4, token: 'zaab-t05', isTakeaway: false, zoneId: zGarden.rows[0].id },
    { num: 'T-06', cap: 4, token: 'zaab-t06', isTakeaway: false, zoneId: zGarden.rows[0].id },
    { num: 'VIP-1', cap: 10, token: 'zaab-vip1', isTakeaway: false, zoneId: zVIP.rows[0].id }
  ];
  for (const t of s2Tables) {
    await query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
       VALUES ($1, $2, $3, $4, $5, 'available', $6)`,
      [s2Id, t.isTakeaway ? null : t.zoneId, t.num, t.cap, t.token, t.isTakeaway]
    );
  }

  const catSomtum = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 1) RETURNING id', [s2Id, 'ส้มตำ & ยำรสแซ่บ', '🥗']);
  const catSoup = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 2) RETURNING id', [s2Id, 'ต้ม & แกงรสเด็ด', '🍲']);
  const catGrill = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 3) RETURNING id', [s2Id, 'ทอด & ย่าง', '🍗']);

  await query(`
    INSERT INTO menus (store_id, category_id, name, description, price, is_available, is_recommend, sort_order)
    VALUES 
    ($1, $2, 'ส้มตำไทยไข่เค็ม', 'มะละกอกรอบ ปรุงรสกลมกล่อม เปรี้ยวหวาน เค็มมันจากไข่เค็มแท้', 85, true, true, 1),
    ($1, $2, 'ส้มตำปูปลาร้าแซ่บนัว', 'ปลาร้าต้มสุกสูตรเด็ดของร้าน หอม นัว ถึงเครื่องอีสานแท้', 75, true, true, 2),
    ($1, $2, 'ตำข้าวโพดไข่เค็มกุ้งสด', 'ข้าวโพดหวาน คลุกเคล้าน้ำยำและกุ้งสดเด้งตัวโต', 120, true, true, 3),
    ($1, $3, 'ต้มแซ่บกระดูกอ่อน', 'กระดูกหมูอ่อนเคี่ยวจนเปื่อย ในน้ำซุปสมุนไพรรสจัดจ้าน', 135, true, true, 1),
    ($1, $3, 'แกงอ่อมไก่บ้าน', 'ผักชีลาวและสมุนไพรสด หอมกลิ่นข้าวคั่ว ซดร้อนๆ คล่องคอ', 120, true, false, 2),
    ($1, $4, 'ไก่ย่างเขาสวนกวาง (ครึ่งตัว)', 'หมักเครื่องเทศสมุนไพร ย่างไฟอ่อนจนหนังกรอบเนื้อนุ่ม', 110, true, true, 1),
    ($1, $4, 'คอหมูย่างจิ้มแจ่ว', 'คอหมูแท้ติดมันนิดๆ ย่างหอมกรุ่น เสิร์ฟคู่น้ำจิ้มแจ่วมะขามเปียก', 125, true, true, 2)
  `, [s2Id, catSomtum.rows[0].id, catSoup.rows[0].id, catGrill.rows[0].id]);

  // -------------------------------------------------------------
  // STORE 3: Enterprise Plan (Grand Buffet Shabu)
  // -------------------------------------------------------------
  console.log('[Reseed] Creating Store 3: Enterprise Plan...');
  const s3 = await query(
    `INSERT INTO stores (
      store_code, name, slug, logo_url, banner_url, address, phone_number,
      promptpay_number, promptpay_name, vat_rate, service_charge,
      plan_name, subscription_price, trial_ends_at, billing_cycle,
      is_open, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '30 days', 'monthly', true, 'active')
    RETURNING id`,
    [
      'ST-ENT',
      '🥩 แกรนด์บุฟเฟต์ ชาบู & ซีฟู้ด (Grand Buffet Shabu)',
      'grand-buffet',
      '🥩',
      'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1200&h=400&fit=crop',
      '999 อาคารเซ็นทรัลทาวเวอร์ ชั้น 5 ถนนพระราม 9 ห้วยขวาง กรุงเทพฯ 10310',
      '089-999-8877',
      '0899998877',
      'บจก. แกรนด์บุฟเฟต์ อินเตอร์เนชั่นแนล',
      7.00,
      10.00,
      'Enterprise / Buffet',
      999.00
    ]
  );
  const s3Id = s3.rows[0].id;

  await query('INSERT INTO store_users (store_id, user_id, role) VALUES ($1, $2, $3)', [s3Id, entMgrId, 'manager']);

  const zBuffetHall = await query('INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [s3Id, 'โถงบุฟเฟต์หลัก (Main Hall)', 1]);
  const zVIPRoom = await query('INSERT INTO table_zones (store_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [s3Id, 'ห้องไพรเวท VIP', 2]);

  const s3Tables = [
    { num: 'กลับบ้าน', cap: 0, token: 'buffet-takeaway', isTakeaway: true },
    { num: 'B-01', cap: 4, token: 'buffet-b01', isTakeaway: false, zoneId: zBuffetHall.rows[0].id },
    { num: 'B-02', cap: 4, token: 'buffet-b02', isTakeaway: false, zoneId: zBuffetHall.rows[0].id },
    { num: 'B-03', cap: 4, token: 'buffet-b03', isTakeaway: false, zoneId: zBuffetHall.rows[0].id },
    { num: 'B-04', cap: 6, token: 'buffet-b04', isTakeaway: false, zoneId: zBuffetHall.rows[0].id },
    { num: 'B-05', cap: 6, token: 'buffet-b05', isTakeaway: false, zoneId: zBuffetHall.rows[0].id },
    { num: 'VIP-01', cap: 12, token: 'buffet-vip01', isTakeaway: false, zoneId: zVIPRoom.rows[0].id },
    { num: 'VIP-02', cap: 12, token: 'buffet-vip02', isTakeaway: false, zoneId: zVIPRoom.rows[0].id }
  ];
  for (const t of s3Tables) {
    await query(
      `INSERT INTO restaurant_tables (store_id, zone_id, table_number, seat_capacity, qr_token, status, is_takeaway)
       VALUES ($1, $2, $3, $4, $5, 'available', $6)`,
      [s3Id, t.isTakeaway ? null : t.zoneId, t.num, t.cap, t.token, t.isTakeaway]
    );
  }

  const catMeat = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 1) RETURNING id', [s3Id, 'เนื้อวากิว & หมูคุโรบูตะ', '🥩']);
  const catSeafood = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 2) RETURNING id', [s3Id, 'ซีฟู้ด & ของทะเลสด', '🦐']);
  const catSet = await query('INSERT INTO categories (store_id, name, icon_url, sort_order) VALUES ($1, $2, $3, 3) RETURNING id', [s3Id, 'ชุดบุฟเฟต์สุดคุ้ม', '👑']);

  await query(`
    INSERT INTO menus (store_id, category_id, name, description, price, is_available, is_recommend, sort_order)
    VALUES 
    ($1, $2, 'เนื้อวากิว A5 สไลซ์พรีเมียม (Wagyu A5)', 'เนื้อวากิวลายหินอ่อน นุ่มละลายในปาก', 399, true, true, 1),
    ($1, $2, 'เนื้อริบอายแองกัส (Angus Ribeye)', 'เนื้อแองกัสออสเตรเลีย กลิ่นหอมเนื้อเข้มข้น', 249, true, true, 2),
    ($1, $2, 'หมูคุโรบูตะ สันคอสไลซ์', 'หมูดำคุโรบูตะ นุ่มฉ่ำ สไลซ์บางกำลังดีสำหรับชาบู', 169, true, false, 3),
    ($1, $3, 'กุ้งแม่น้ำตัวโต (River Prawn)', 'กุ้งแม่น้ำสด มันกุ้งเยิ้มๆ พร้อมน้ำจิ้มซีฟู้ดมะนาวแท้', 299, true, true, 1),
    ($1, $3, 'หอยเชลล์ฮอกไกโด (Hokkaido Scallop)', 'หอยเชลล์นำเข้า หวานฉ่ำ สดใหม่', 279, true, true, 2),
    ($1, $4, 'บุฟเฟต์พรีเมียม ชาบู & ซีฟู้ด (All-You-Can-Eat)', 'ทานได้ไม่อั้น 120 นาที รวมเครื่องดื่มและของหวาน', 699, true, true, 1)
  `, [s3Id, catMeat.rows[0].id, catSeafood.rows[0].id, catSet.rows[0].id]);

  console.log('[Reseed] Successfully created 3 stores with Starter, Professional, Enterprise plans! 🎉');
}

reseedThreeStores()
  .then(() => {
    console.log('[Reseed] Complete! Exiting...');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[Reseed Error]:', err);
    process.exit(1);
  });
