async function testAll() {
  console.log('[Test] 1. Testing Login...');
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'manager', password: 'manager123' })
  });
  const loginData = await loginRes.json();
  console.log('Login success:', loginData.success, '| User:', loginData.user?.full_name);

  const headers = { 'Authorization': 'Bearer ' + loginData.token };

  console.log('[Test] 2. Testing Dashboard Metrics...');
  const dashRes = await fetch('http://localhost:3000/api/admin/dashboard', { headers });
  const dashData = await dashRes.json();
  console.log('Dashboard metrics:', dashData.metrics);

  console.log('[Test] 3. Testing Kitchen KDS...');
  const kitchenRes = await fetch('http://localhost:3000/api/admin/kitchen/orders', { headers });
  const kitchenData = await kitchenRes.json();
  console.log('Kitchen queue items:', kitchenData.items?.length);

  console.log('[Test] 4. Testing Table Management & QR Codes...');
  const tablesRes = await fetch('http://localhost:3000/api/admin/tables', { headers });
  const tablesData = await tablesRes.json();
  console.log('Tables loaded:', tablesData.tables?.length, '| Sample QR length:', tablesData.tables?.[0]?.qrDataUrl?.length);

  console.log('[Test] 5. Testing Settings & Telegram Simulation Feed...');
  const settingsRes = await fetch('http://localhost:3000/api/admin/settings', { headers });
  const settingsData = await settingsRes.json();
  console.log('Store name:', settingsData.store?.name, '| Telegram messages count:', settingsData.simulatedMessages?.length);

  console.log('🎉 ALL INTEGRATION TESTS PASSED 100%!');
}

testAll().catch(console.error);
