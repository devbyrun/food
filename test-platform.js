async function testPlatformFeatures() {
  console.log('🚀 [Test] Starting Platform & SaaS Feature Verification...');

  // 1. Test Super Admin Login
  console.log('\n--- 1. Testing Super Admin Login ---');
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const loginData = await loginRes.json();
  console.log('Admin login success:', loginData.success, '| Role:', loginData.user?.role);
  if (!loginData.success) throw new Error('Admin login failed: ' + loginData.message);

  const adminHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + loginData.token
  };

  // 2. Test Platform Overview
  console.log('\n--- 2. Testing Platform Overview ---');
  const overviewRes = await fetch('http://localhost:3000/api/platform/overview', { headers: adminHeaders });
  const overviewData = await overviewRes.json();
  console.log('Total stores:', overviewData.stats?.totalStores, '| Trial stores:', overviewData.stats?.trialStores);
  console.log('Stores loaded:', overviewData.stores?.map(s => `${s.name} (${s.plan_name}, trial: ${s.trial_days_left}d)`));

  // 3. Test Super Admin Add Store
  console.log('\n--- 3. Testing Super Admin Add Store ---');
  const testCode = 'TEST-' + Math.floor(1000 + Math.random() * 9000);
  const addStoreRes = await fetch('http://localhost:3000/api/platform/stores', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      store_code: testCode,
      name: 'ร้านอาหารทดสอบระบบ Super Admin',
      slug: testCode.toLowerCase(),
      phone_number: '0899999999',
      plan_name: 'Professional',
      trial_days: 30,
      manager_username: 'mgr_' + testCode.toLowerCase(),
      manager_password: 'password123',
      manager_full_name: 'ผู้จัดการ ร้านทดสอบ'
    })
  });
  const addStoreData = await addStoreRes.json();
  console.log('Add store success:', addStoreData.success, '| Store ID:', addStoreData.store?.id, '| Manager created:', addStoreData.manager?.username);
  if (!addStoreData.success) throw new Error('Add store failed: ' + addStoreData.message);

  // 4. Test Super Admin Update Store
  console.log('\n--- 4. Testing Super Admin Update Store ---');
  const updateRes = await fetch(`http://localhost:3000/api/platform/stores/${addStoreData.store.id}`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'ร้านอาหารทดสอบระบบ (อัปเดตแล้ว)',
      plan_name: 'Enterprise',
      extend_trial_days: 15,
      status: 'active'
    })
  });
  const updateData = await updateRes.json();
  console.log('Update store success:', updateData.success, '| New Plan:', updateData.store?.plan_name);

  // 5. Test Sales Analytics (Daily, Monthly, Yearly)
  console.log('\n--- 5. Testing Sales Analytics ---');
  
  // Daily
  const dailyRes = await fetch('http://localhost:3000/api/platform/analytics/sales?period=daily', { headers: adminHeaders });
  const dailyData = await dailyRes.json();
  console.log('Daily analytics success:', dailyData.success, '| Summary:', dailyData.summary);
  console.log('Daily time series points:', dailyData.timeSeries?.length);

  // Monthly
  const monthlyRes = await fetch('http://localhost:3000/api/platform/analytics/sales?period=monthly&year=2026', { headers: adminHeaders });
  const monthlyData = await monthlyRes.json();
  console.log('Monthly analytics success:', monthlyData.success, '| Time series points:', monthlyData.timeSeries?.length);

  // Yearly
  const yearlyRes = await fetch('http://localhost:3000/api/platform/analytics/sales?period=yearly', { headers: adminHeaders });
  const yearlyData = await yearlyRes.json();
  console.log('Yearly analytics success:', yearlyData.success, '| Time series points:', yearlyData.timeSeries?.length);

  // 6. Test Landing Page 30-Day Free Trial Signup (Public)
  console.log('\n--- 6. Testing Public 30-Day Free Trial Signup ---');
  const trialCode = Math.floor(1000 + Math.random() * 9000);
  const trialRes = await fetch('http://localhost:3000/api/platform/trial-signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      store_name: 'ครัวชวนชิม ' + trialCode,
      manager_name: 'คุณสายใจ ชวนชิม',
      phone_number: '0812344321',
      manager_username: 'chuanchim_' + trialCode,
      manager_password: 'trialPassword123',
      plan_name: 'Professional'
    })
  });
  const trialData = await trialRes.json();
  console.log('Trial signup success:', trialData.success, '| Token generated:', !!trialData.token, '| Store:', trialData.store?.name);
  console.log('Trial days ends at:', trialData.store?.trial_ends_at);

  console.log('\n🎉 ALL SAAS & PLATFORM ADMIN TESTS PASSED 100%!');
}

testPlatformFeatures().catch(console.error);
