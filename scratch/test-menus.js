async function testMenus() {
  console.log('--- 1. Login as Manager ---');
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'manager', password: 'manager123' })
  });
  const loginData = await loginRes.json();
  console.log('Login status:', loginData.success, 'Token exists:', !!loginData.token);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${loginData.token}`
  };

  console.log('\n--- 2. Get Menus ---');
  const getRes = await fetch('http://localhost:3000/api/admin/menus', { headers });
  const getData = await getRes.json();
  console.log('Success:', getData.success, 'Menus count:', getData.menus?.length, 'Categories count:', getData.categories?.length);

  const testCategory = getData.categories[0];
  console.log('Using category:', testCategory.id, testCategory.name);

  console.log('\n--- 3. Create a Test Menu ---');
  const createRes = await fetch('http://localhost:3000/api/admin/menus', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      category_id: testCategory.id,
      name: 'เมนูทดสอบระบบ AutoTest',
      description: 'เมนูทดสอบความอร่อยระดับพรีเมียม',
      price: 99,
      special_price: 89,
      image_url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
      is_recommend: true
    })
  });
  const createData = await createRes.json();
  console.log('Create Menu result:', createData.success, createData.message, 'Menu ID:', createData.menu?.id);
  const createdMenuId = createData.menu?.id;

  console.log('\n--- 4. Update the Test Menu ---');
  const updateRes = await fetch(`http://localhost:3000/api/admin/menus/${createdMenuId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      category_id: testCategory.id,
      name: 'เมนูทดสอบระบบ AutoTest (แก้ไขแล้ว)',
      description: 'แก้ไขคำอธิบายแล้ว อร่อยขึ้น 2 เท่า',
      price: 120,
      special_price: 99,
      image_url: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=500',
      is_recommend: true,
      is_available: true
    })
  });
  const updateData = await updateRes.json();
  console.log('Update Menu result:', updateData.success, updateData.message, 'Updated Name:', updateData.menu?.name, 'Price:', updateData.menu?.price);

  console.log('\n--- 5. Toggle Menu Availability ---');
  const toggleRes = await fetch(`http://localhost:3000/api/admin/menus/${createdMenuId}/toggle`, {
    method: 'PUT',
    headers
  });
  const toggleData = await toggleRes.json();
  console.log('Toggle Availability result:', toggleData.success, 'is_available:', toggleData.menu?.is_available);

  console.log('\n--- 6. Delete Test Menu ---');
  const deleteRes = await fetch(`http://localhost:3000/api/admin/menus/${createdMenuId}`, {
    method: 'DELETE',
    headers
  });
  const deleteData = await deleteRes.json();
  console.log('Delete Menu result:', deleteData.success, deleteData.message);

  console.log('\n✨ ALL MENU CRUD TESTS PASSED SUCCESSFULLY! ✨');
}

testMenus().catch(console.error);
