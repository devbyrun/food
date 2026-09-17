const { query } = require('../src/db');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const users = [
      { u: 'admin', p: 'admin123' },
      { u: 'manager', p: 'manager123' },
      { u: 'staff', p: 'staff123' },
    ];

    for (const item of users) {
      const res = await query('SELECT * FROM users WHERE username = $1', [item.u]);
      if (res.rows.length === 0) {
        console.log(`❌ User ${item.u} not found!`);
        continue;
      }
      const isMatch = await bcrypt.compare(item.p, res.rows[0].password_hash);
      console.log(`User: ${item.u}, Password: ${item.p} -> Match: ${isMatch ? '✅ OK' : '❌ FAILED'}`);
      if (!isMatch) {
        console.log(`Fixing password for ${item.u}...`);
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(item.p, salt);
        await query('UPDATE users SET password_hash = $1 WHERE username = $2', [newHash, item.u]);
        console.log(`Password for ${item.u} fixed to ${item.p}!`);
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
