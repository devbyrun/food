const { query } = require('../src/db');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const res = await query("SELECT * FROM users WHERE username = 'staff'");
    console.log('Staff row:', res.rows[0]);
    if (res.rows[0]) {
      const isMatch = await bcrypt.compare('staff123', res.rows[0].password_hash);
      console.log('staff123 match?:', isMatch);
      if (!isMatch) {
        console.log('Resetting password for staff to staff123...');
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash('staff123', salt);
        await query("UPDATE users SET password_hash = $1 WHERE username = 'staff'", [newHash]);
        console.log('Password reset to staff123 successfully!');
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
