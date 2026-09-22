const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, getClient } = require('../db');
const { JWT_SECRET } = require('../middlewares/auth');
const lineAuthService = require('../services/lineAuthService');

function buildUserPayload(user) {
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    avatar_url: user.avatar_url || user.line_picture_url || '👨‍🍳',
    line_user_id: user.line_user_id || null,
    line_display_name: user.line_display_name || null,
    store_id: user.store_id || null,
    store_role: user.store_role || null,
    store_slug: user.store_slug || null,
    store_name: user.store_name || null,
    trial_ends_at: user.trial_ends_at || null,
    plan_name: user.plan_name || null,
    store_status: user.store_status || null,
  };
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  });
}

// -------------------------------------------------------------
// Standard Username & Password Login
// -------------------------------------------------------------
async function login(req, res) {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อผู้ใช้และรหัสผ่าน' });
    }

    const userRes = await query(
      `SELECT u.*, su.store_id, su.role as store_role, s.slug as store_slug, s.name as store_name,
              s.trial_ends_at, s.plan_name, s.status as store_status
       FROM users u
       LEFT JOIN store_users su ON u.id = su.user_id AND su.is_active = TRUE
       LEFT JOIN stores s ON su.store_id = s.id
       WHERE u.username = $1 AND u.is_active = TRUE`,
      [username.trim()]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const user = userRes.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ success: false, message: 'บัญชีนี้ลงทะเบียนผ่าน LINE กรุณาเข้าสู่ระบบด้วย LINE' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const payload = buildUserPayload(user);
    const token = generateToken(payload);
    setAuthCookie(res, token);

    let redirectUrl = '/store.html';
    if (user.role === 'admin') {
      redirectUrl = '/superadmin.html';
    }

    return res.json({
      success: true,
      message: 'เข้าสู่ระบบสำเร็จ',
      token,
      user: payload,
      redirectUrl,
    });
  } catch (err) {
    console.error('[Auth Login Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดของระบบ' });
  }
}

// -------------------------------------------------------------
// LINE Config & OAuth Endpoints
// -------------------------------------------------------------
function getLineConfig(req, res) {
  try {
    const isConfigured = lineAuthService.isLineConfigured();
    const creds = lineAuthService.getLineCredentials();
    return res.json({
      success: true,
      isConfigured,
      channelId: creds.channelId || null,
      liffId: creds.liffId || null,
      callbackUrl: lineAuthService.getCallbackUrl(req),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function getLineAuthUrl(req, res) {
  try {
    const { state = 'free_trial', redirect = '' } = req.query;
    const authUrl = lineAuthService.getAuthorizationUrl(req, state, redirect);
    return res.json({ success: true, authUrl });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function lineOAuthCallback(req, res) {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.warn('[LINE Callback Error]:', error, error_description);
      return res.redirect(`/?line_error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
      return res.redirect('/?line_error=missing_code');
    }

    // Exchange authorization code for token & profile
    const tokenData = await lineAuthService.exchangeCodeForToken(code, req);
    const lineProfile = await lineAuthService.getLineProfile(tokenData.access_token);

    // Optional: check ID token email if available
    let email = null;
    if (tokenData.id_token) {
      const idInfo = await lineAuthService.verifyIdToken(tokenData.id_token);
      if (idInfo && idInfo.email) email = idInfo.email;
    }

    // Query DB for user with this LINE User ID
    const userRes = await query(
      `SELECT u.*, su.store_id, su.role as store_role, s.slug as store_slug, s.name as store_name,
              s.trial_ends_at, s.plan_name, s.status as store_status
       FROM users u
       LEFT JOIN store_users su ON u.id = su.user_id AND su.is_active = TRUE
       LEFT JOIN stores s ON su.store_id = s.id
       WHERE u.line_user_id = $1 AND u.is_active = TRUE`,
      [lineProfile.userId]
    );

    if (userRes.rows.length > 0) {
      // Existing User -> Update avatar & line details
      const user = userRes.rows[0];
      await query(
        `UPDATE users
         SET line_display_name = COALESCE($1, line_display_name),
             line_picture_url = COALESCE($2, line_picture_url),
             avatar_url = COALESCE($2, avatar_url),
             line_access_token = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [lineProfile.displayName, lineProfile.pictureUrl, tokenData.access_token, user.id]
      );

      const payload = buildUserPayload({
        ...user,
        line_display_name: lineProfile.displayName || user.line_display_name,
        line_picture_url: lineProfile.pictureUrl || user.line_picture_url,
        avatar_url: lineProfile.pictureUrl || user.avatar_url,
      });

      const token = generateToken(payload);
      setAuthCookie(res, token);

      let redirectUrl = '/store.html';
      if (user.role === 'admin') redirectUrl = '/superadmin.html';

      return res.redirect(`${redirectUrl}?line_login=success&token=${encodeURIComponent(token)}`);
    } else {
      // New LINE User -> Redirect to home page with step=setup to confirm store creation
      const params = new URLSearchParams({
        line_step: 'setup',
        line_id: lineProfile.userId,
        line_name: lineProfile.displayName || '',
        line_pic: lineProfile.pictureUrl || '',
        line_email: email || '',
        state: state || 'free_trial',
      });
      return res.redirect(`/?${params.toString()}`);
    }
  } catch (err) {
    console.error('[LINE OAuth Callback Error]:', err);
    return res.redirect(`/?line_error=${encodeURIComponent(err.message)}`);
  }
}

// -------------------------------------------------------------
// LINE Direct Login (LIFF / Client Profile / Instant Auth)
// -------------------------------------------------------------
async function lineLogin(req, res) {
  try {
    const { line_user_id, displayName, pictureUrl, email } = req.body;

    if (!line_user_id) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุ LINE User ID' });
    }

    const userRes = await query(
      `SELECT u.*, su.store_id, su.role as store_role, s.slug as store_slug, s.name as store_name,
              s.trial_ends_at, s.plan_name, s.status as store_status
       FROM users u
       LEFT JOIN store_users su ON u.id = su.user_id AND su.is_active = TRUE
       LEFT JOIN stores s ON su.store_id = s.id
       WHERE u.line_user_id = $1 AND u.is_active = TRUE`,
      [line_user_id.trim()]
    );

    if (userRes.rows.length === 0) {
      // User does not exist yet -> Let client know to proceed with Trial Store Setup
      return res.json({
        success: true,
        isNewUser: true,
        message: 'ยืนยันตัวตน LINE สำเร็จ กรุณาระบุชื่อร้านเพื่อเปิดทดลองใช้งานฟรี 30 วัน',
        lineProfile: {
          line_user_id: line_user_id.trim(),
          displayName: displayName || 'ผู้ใช้ LINE',
          pictureUrl: pictureUrl || null,
          email: email || null,
        },
      });
    }

    const user = userRes.rows[0];

    // Update latest LINE display name / picture if provided
    if (displayName || pictureUrl) {
      await query(
        `UPDATE users
         SET line_display_name = COALESCE($1, line_display_name),
             line_picture_url = COALESCE($2, line_picture_url),
             avatar_url = COALESCE($2, avatar_url),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [displayName || null, pictureUrl || null, user.id]
      );
    }

    const payload = buildUserPayload({
      ...user,
      line_display_name: displayName || user.line_display_name,
      line_picture_url: pictureUrl || user.line_picture_url,
      avatar_url: pictureUrl || user.avatar_url,
    });

    const token = generateToken(payload);
    setAuthCookie(res, token);

    let redirectUrl = '/store.html';
    if (user.role === 'admin') redirectUrl = '/superadmin.html';

    return res.json({
      success: true,
      isNewUser: false,
      message: `ยินดีต้อนรับกลับ ${payload.full_name || displayName}! 🎉`,
      token,
      user: payload,
      redirectUrl,
    });
  } catch (err) {
    console.error('[Auth lineLogin Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดของระบบ: ' + err.message });
  }
}

// -------------------------------------------------------------
// LINE Trial Store Signup (30-Day Free Trial via LINE)
// -------------------------------------------------------------
async function lineTrialSignup(req, res) {
  const client = await getClient();
  try {
    const {
      line_user_id,
      displayName,
      pictureUrl,
      store_name,
      phone_number,
      plan_name = 'Professional',
      email
    } = req.body;

    if (!line_user_id) {
      return res.status(400).json({ success: false, message: 'กรุณายืนยันตัวตนด้วย LINE ก่อนเปิดร้านค้า' });
    }

    if (!store_name || !store_name.trim()) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อร้านอาหารของคุณ' });
    }

    await client.query('BEGIN');

    // 1. Check if user already exists by LINE User ID
    const existingUserRes = await client.query(
      `SELECT u.*, su.store_id 
       FROM users u 
       LEFT JOIN store_users su ON u.id = su.user_id 
       WHERE u.line_user_id = $1`,
      [line_user_id.trim()]
    );

    let userId;
    let existingUser = existingUserRes.rows[0];

    if (existingUser) {
      userId = existingUser.id;
      // If already linked to a store, return existing store session
      if (existingUser.store_id) {
        await client.query('ROLLBACK');

        const fullUserRes = await query(
          `SELECT u.*, su.store_id, su.role as store_role, s.slug as store_slug, s.name as store_name,
                  s.trial_ends_at, s.plan_name, s.status as store_status
           FROM users u
           LEFT JOIN store_users su ON u.id = su.user_id AND su.is_active = TRUE
           LEFT JOIN stores s ON su.store_id = s.id
           WHERE u.id = $1`,
          [userId]
        );
        const user = fullUserRes.rows[0];
        const payload = buildUserPayload(user);
        const token = generateToken(payload);
        setAuthCookie(res, token);

        return res.json({
          success: true,
          message: 'พบร้านค้าเดิมของคุณแล้ว กำลังพาท่านเข้าสู่ระบบ...',
          token,
          user: payload,
          redirectUrl: '/store.html',
        });
      }
    } else {
      // Create new user for LINE
      const cleanName = (displayName || store_name || 'ผู้จัดการร้าน').trim();
      const randSuffix = Math.floor(1000 + Math.random() * 9000);
      const generatedUsername = `line_${line_user_id.slice(-6).toLowerCase()}_${randSuffix}`;
      const userEmail = (email || `${generatedUsername}@line.user`).trim();

      const userInsert = await client.query(
        `INSERT INTO users (
          username, email, password_hash, full_name, phone_number, role,
          avatar_url, line_user_id, line_display_name, line_picture_url
        ) VALUES ($1, $2, $3, $4, $5, 'manager', $6, $7, $8, $9)
        RETURNING *`,
        [
          generatedUsername,
          userEmail,
          '', // No password needed for LINE login
          cleanName,
          phone_number ? phone_number.trim() : null,
          pictureUrl || '👨‍🍳',
          line_user_id.trim(),
          cleanName,
          pictureUrl || null,
        ]
      );
      userId = userInsert.rows[0].id;
    }

    // 2. Generate Store Slug & Code
    const rawSlug = store_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'shop';
    const randCode = Math.floor(1000 + Math.random() * 9000);
    const slug = `${rawSlug}-${randCode}`;
    const store_code = `ST-${randCode}`;
    const price = plan_name === 'Enterprise' ? 990 : 490;

    // 3. Create Store with 30-Day Free Trial
    const storeRes = await client.query(
      `INSERT INTO stores (
        store_code, name, slug, phone_number, plan_name, subscription_price,
        trial_ends_at, billing_cycle, status, line_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '30 days', 'monthly', 'active', $7)
      RETURNING *`,
      [store_code, store_name.trim(), slug, phone_number || '', plan_name, price, line_user_id.trim()]
    );
    const newStore = storeRes.rows[0];

    // 4. Create Initial Table Zone & 3 Sample Tables
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

    // 5. Create Sample Categories & Recommended Menus
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

    // 6. Link User as Store Manager
    await client.query(
      `INSERT INTO store_users (store_id, user_id, role) VALUES ($1, $2, 'manager')
       ON CONFLICT (store_id, user_id) DO UPDATE SET role = 'manager', is_active = TRUE`,
      [newStore.id, userId]
    );

    await client.query('COMMIT');

    // 7. Generate JWT Payload & Cookie
    const payload = {
      id: userId,
      full_name: displayName || store_name,
      role: 'manager',
      avatar_url: pictureUrl || '👨‍🍳',
      line_user_id: line_user_id.trim(),
      line_display_name: displayName || null,
      store_id: newStore.id,
      store_role: 'manager',
      store_slug: newStore.slug,
      store_name: newStore.name,
      trial_ends_at: newStore.trial_ends_at,
      plan_name: newStore.plan_name,
      store_status: newStore.status,
    };

    const token = generateToken(payload);
    setAuthCookie(res, token);

    return res.json({
      success: true,
      message: 'เปิดร้านค้าทดลองใช้งานฟรี 30 วันสำเร็จแล้ว! 🎉',
      token,
      store: newStore,
      user: payload,
      redirectUrl: '/store.html',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Auth lineTrialSignup Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเปิดร้านค้าทดลองใช้งาน: ' + err.message });
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// Get Authenticated User Profile
// -------------------------------------------------------------
async function getMe(req, res) {
  try {
    const userRes = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone_number, u.role, u.avatar_url,
              u.line_user_id, u.line_display_name, u.line_picture_url,
              su.store_id, su.role as store_role, s.slug as store_slug, s.name as store_name, s.logo_url as store_logo_url,
              s.trial_ends_at, s.plan_name, s.status as store_status
       FROM users u
       LEFT JOIN store_users su ON u.id = su.user_id AND su.is_active = TRUE
       LEFT JOIN stores s ON su.store_id = s.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({ success: true, user: userRes.rows[0] });
  } catch (err) {
    console.error('[Auth getMe Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดของระบบ' });
  }
}

// -------------------------------------------------------------
// Update User Profile
// -------------------------------------------------------------
async function updateProfile(req, res) {
  try {
    const userId = req.user.id;
    const { full_name, email, phone_number, avatar_url, current_password, new_password } = req.body;

    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้' });
    }
    const currentUser = userRes.rows[0];

    if (email && email.trim() !== currentUser.email) {
      const emailCheck = await query(
        `SELECT id FROM users WHERE email = $1 AND id != $2`,
        [email.trim(), userId]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'อีเมลนี้มีผู้ใช้งานอื่นใช้อยู่แล้ว' });
      }
    }

    let passwordHash = currentUser.password_hash;
    if (new_password) {
      if (currentUser.password_hash && !current_password) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสผ่านปัจจุบันเพื่อตั้งรหัสผ่านใหม่' });
      }
      if (currentUser.password_hash && current_password) {
        const isMatch = await bcrypt.compare(current_password, currentUser.password_hash);
        if (!isMatch) {
          return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
        }
      }
      if (new_password.length < 6) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 6 ตัวอักษร' });
      }
      passwordHash = await bcrypt.hash(new_password, 10);
    }

    const updatedFullName = full_name ? full_name.trim() : currentUser.full_name;
    const updatedEmail = email ? email.trim() : currentUser.email;
    const updatedPhone = phone_number !== undefined ? (phone_number ? phone_number.trim() : null) : currentUser.phone_number;
    const updatedAvatar = avatar_url !== undefined ? avatar_url : (currentUser.avatar_url || '👨‍🍳');

    const updateRes = await query(
      `UPDATE users
       SET full_name = $1, email = $2, phone_number = $3, avatar_url = $4, password_hash = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, username, email, full_name, phone_number, role, avatar_url, line_user_id, line_display_name, line_picture_url`,
      [updatedFullName, updatedEmail, updatedPhone, updatedAvatar, passwordHash, userId]
    );

    const updatedUser = updateRes.rows[0];

    return res.json({
      success: true,
      message: 'บันทึกการตั้งค่าโปรไฟล์เรียบร้อยแล้ว',
      user: updatedUser
    });
  } catch (err) {
    console.error('[Auth updateProfile Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดของระบบ: ' + err.message });
  }
}

// -------------------------------------------------------------
// Logout
// -------------------------------------------------------------
async function logout(req, res) {
  res.clearCookie('token');
  return res.json({ success: true, message: 'ออกจากระบบเรียบร้อย' });
}

module.exports = {
  login,
  getMe,
  updateProfile,
  logout,
  getLineConfig,
  getLineAuthUrl,
  lineOAuthCallback,
  lineLogin,
  lineTrialSignup,
};
