async function testPermissions() {
  console.log('🧪 Testing Staff vs Manager Permissions...');

  // 1. Login as Staff
  const staffLoginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'staff', password: 'staff123' })
  });
  const staffData = await staffLoginRes.json();
  console.log('Staff login:', staffData.user?.full_name, '| Role:', staffData.user?.store_role);

  const staffHeaders = { 'Authorization': 'Bearer ' + staffData.token };

  // 2. Try Accessing Reports as Staff (Should be 403)
  const staffReportsRes = await fetch('http://localhost:3000/api/admin/reports', { headers: staffHeaders });
  console.log('Staff accessing Reports status:', staffReportsRes.status, staffReportsRes.status === 403 ? '✅ Blocked 403' : '❌ Failed');

  // 3. Try Accessing Settings as Staff (Should be 403)
  const staffSettingsRes = await fetch('http://localhost:3000/api/admin/settings', { headers: staffHeaders });
  console.log('Staff accessing Settings status:', staffSettingsRes.status, staffSettingsRes.status === 403 ? '✅ Blocked 403' : '❌ Failed');

  // 4. Try Accessing Tables & Kitchen as Staff (Should be 200)
  const staffTablesRes = await fetch('http://localhost:3000/api/admin/tables', { headers: staffHeaders });
  console.log('Staff accessing Tables status:', staffTablesRes.status, staffTablesRes.status === 200 ? '✅ Allowed 200' : '❌ Failed');

  // 5. Login as Manager
  const mgrLoginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'manager', password: 'manager123' })
  });
  const mgrData = await mgrLoginRes.json();
  console.log('\nManager login:', mgrData.user?.full_name, '| Role:', mgrData.user?.store_role);

  const mgrHeaders = { 'Authorization': 'Bearer ' + mgrData.token };

  // 6. Access Reports & Settings as Manager (Should be 200)
  const mgrReportsRes = await fetch('http://localhost:3000/api/admin/reports', { headers: mgrHeaders });
  console.log('Manager accessing Reports status:', mgrReportsRes.status, mgrReportsRes.status === 200 ? '✅ Allowed 200' : '❌ Failed');

  const mgrSettingsRes = await fetch('http://localhost:3000/api/admin/settings', { headers: mgrHeaders });
  console.log('Manager accessing Settings status:', mgrSettingsRes.status, mgrSettingsRes.status === 200 ? '✅ Allowed 200' : '❌ Failed');

  console.log('\n🎉 Role-based permission verification complete 100%!');
}

testPermissions().catch(console.error);
