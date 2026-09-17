const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { JWT_SECRET } = require('../middlewares/auth');

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
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      avatar_url: user.avatar_url || '👨‍🍳',
      store_id: user.store_id,
      store_role: user.store_role,
      store_slug: user.store_slug,
      store_name: user.store_name,
      trial_ends_at: user.trial_ends_at,
      plan_name: user.plan_name,
      store_status: user.store_status,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

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

async function getMe(req, res) {
  try {
    const userRes = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone_number, u.role, u.avatar_url,
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

async function updateProfile(req, res) {
  try {
    const userId = req.user.id;
    const { full_name, email, phone_number, avatar_url, current_password, new_password } = req.body;

    // Get current user
    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้' });
    }
    const currentUser = userRes.rows[0];

    // Check email uniqueness if changing email
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
      if (!current_password) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสผ่านปัจจุบันเพื่อตั้งรหัสผ่านใหม่' });
      }
      const isMatch = await bcrypt.compare(current_password, currentUser.password_hash);
      if (!isMatch) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
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
       RETURNING id, username, email, full_name, phone_number, role, avatar_url`,
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

async function logout(req, res) {
  res.clearCookie('token');
  return res.json({ success: true, message: 'ออกจากระบบเรียบร้อย' });
}

module.exports = {
  login,
  getMe,
  updateProfile,
  logout,
};
