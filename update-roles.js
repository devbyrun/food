const { query } = require('./src/db');

async function updateRoles() {
  console.log('Updating user roles to: admin (เจ้าของเว็บ), manager (เจ้าของร้าน), staff (พนักงาน)...');
  
  await query(`
    UPDATE users u
    SET role = COALESCE(
      (SELECT su.role FROM store_users su WHERE su.user_id = u.id LIMIT 1),
      CASE WHEN u.username = 'admin' THEN 'admin' ELSE 'staff' END
    )
  `);

  await query("UPDATE users SET role = 'admin' WHERE username = 'admin'");

  const res = await query('SELECT id, username, full_name, role FROM users ORDER BY id');
  console.log('Resulting users in DB:');
  console.table(res.rows);
  process.exit(0);
}

updateRoles().catch(e => { console.error(e); process.exit(1); });
