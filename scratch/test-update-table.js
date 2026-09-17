async function testUpdateTable() {
  console.log('--- 1. Login ---');
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'manager', password: 'manager123' })
  });
  const loginData = await loginRes.json();
  console.log('Login:', loginData.success, 'Token:', !!loginData.token);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${loginData.token}`
  };

  console.log('\n--- 2. Get Tables ---');
  const tablesRes = await fetch('http://localhost:3000/api/admin/tables?store_id=1', { headers });
  const tablesData = await tablesRes.json();
  console.log('Tables count:', tablesData.tables?.length);
  const t3 = tablesData.tables.find(t => t.table_number === 'T-03' || t.table_number.includes('3'));
  console.log('Found table:', t3);

  if (t3) {
    console.log('\n--- 3. Try Update Table ---');
    const updateRes = await fetch(`http://localhost:3000/api/admin/tables/${t3.id}?store_id=1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        table_number: t3.table_number,
        seat_capacity: 2,
        zone_id: null
      })
    });
    const updateStatus = updateRes.status;
    const updateData = await updateRes.json();
    console.log('Update status:', updateStatus, 'Result:', updateData);
  }
}

testUpdateTable().catch(console.error);
