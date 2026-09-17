const { query } = require('../src/db');

async function initPlans() {
  try {
    console.log('[Init Plans] Ensuring subscription_plans table exists...');
    await query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        subtitle VARCHAR(255),
        price_monthly NUMERIC(10,2) NOT NULL DEFAULT 0.00,
        price_yearly NUMERIC(10,2) NOT NULL DEFAULT 0.00,
        features JSONB NOT NULL DEFAULT '[]'::jsonb,
        disabled_features JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_featured BOOLEAN DEFAULT FALSE,
        badge_text VARCHAR(50),
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const starterFeatures = [
      "รองรับสูงสุด 10 โต๊ะ (ไม่รวมหน้าร้าน)",
      "สูงสุด 50 รายการเมนูอาหาร",
      "สแกน QR สั่งอาหารผ่านมือถือ",
      "แจ้งเตือนออเดอร์เข้า Telegram ครัว",
      "ระบบสร้าง QR พร้อมเพย์ชำระเงิน"
    ];
    const starterDisabled = [
      "จอครัว KDS แบบเรียลไทม์",
      "วิเคราะห์ยอดขายขั้นสูงรายปี"
    ];

    const proFeatures = [
      "รองรับสูงสุด 20 โต๊ะ (ไม่รวมหน้าร้าน)",
      "ไม่จำกัดรายการเมนู และหมวดหมู่",
      "สแกน QR สั่งอาหาร + ปรับแต่ง Option",
      "หน้าจอครัว KDS สด พร้อมเสียงเตือน",
      "Telegram Bot ครัว, เสิร์ฟ, สลิปลูกค้า",
      "ระบบผังโต๊ะสด & คิดเงิน POS + VAT",
      "รายงานยอดขายรายวันและรายเดือน",
      "ทีมงานดูแลช่วยเหลือทาง Line/โทร"
    ];

    const enterpriseFeatures = [
      "ทุกฟังก์ชันในแพ็กเกจ Professional",
      "รองรับระบบ Multi-Store หลายสาขา",
      "ระบบ Super Admin ควบคุมทุกสาขาจากที่เดียว",
      "วิเคราะห์ยอดขายขั้นสูง รายวัน / รายเดือน / รายปี",
      "ปรับแต่งธีมและโลโก้แบรนด์เฉพาะตัว",
      "Export ข้อมูล Excel / CSV ครบครัน",
      "บริการให้คำปรึกษา & ซัพพอร์ต 24/7"
    ];

    await query(`
      INSERT INTO subscription_plans (code, name, subtitle, price_monthly, price_yearly, features, disabled_features, is_featured, badge_text, sort_order, is_active)
      VALUES
      (
        'starter',
        'Starter',
        'เหมาะสำหรับร้านขนาดเล็ก คาเฟ่ หรือร้านกาแฟ',
        290.00,
        230.00,
        $1::jsonb,
        $2::jsonb,
        FALSE,
        NULL,
        1,
        TRUE
      ),
      (
        'professional',
        'Professional',
        'สำหรับร้านอาหารทั่วไป ชาบู ปิ้งย่าง หรือสวนอาหาร',
        490.00,
        390.00,
        $3::jsonb,
        '[]'::jsonb,
        TRUE,
        '🌟 ยอดนิยมที่สุด',
        2,
        TRUE
      ),
      (
        'enterprise',
        'Enterprise / Buffet',
        'สำหรับร้านบุฟเฟต์ ภัตตาคาร หรือร้านที่มีหลายสาขา',
        999.00,
        799.00,
        $4::jsonb,
        '[]'::jsonb,
        FALSE,
        NULL,
        3,
        TRUE
      )
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        subtitle = EXCLUDED.subtitle,
        price_monthly = EXCLUDED.price_monthly,
        price_yearly = EXCLUDED.price_yearly,
        features = EXCLUDED.features,
        disabled_features = EXCLUDED.disabled_features,
        is_featured = EXCLUDED.is_featured,
        badge_text = EXCLUDED.badge_text,
        sort_order = EXCLUDED.sort_order,
        is_active = EXCLUDED.is_active;
    `, [
      JSON.stringify(starterFeatures),
      JSON.stringify(starterDisabled),
      JSON.stringify(proFeatures),
      JSON.stringify(enterpriseFeatures)
    ]);

    const res = await query('SELECT id, code, name, price_monthly, price_yearly, is_featured, is_active FROM subscription_plans ORDER BY sort_order ASC');
    console.log('Successfully initialized plans in database:');
    console.table(res.rows);
    process.exit(0);
  } catch (err) {
    console.error('Error initializing plans:', err);
    process.exit(1);
  }
}

initPlans();
