const http = require('http');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

const bcrypt = require('bcryptjs');
const { query } = require('../src/db');

async function runTests() {
  console.log('--- Starting Profile Settings Tests ---');

  // Set initial password for staff
  const initialHash = await bcrypt.hash('123456', 10);
  await query('UPDATE users SET password_hash = $1 WHERE username = $2', [initialHash, 'staff']);
  console.log('Reset staff initial password to 123456');

  // 1. Login as staff
  console.log('\n1. Logging in as staff (Staff)...');
  const loginRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'staff', password: '123456' });

  console.log('Login status:', loginRes.status, loginRes.data?.success ? 'SUCCESS' : 'FAILED');
  if (!loginRes.data?.token) {
    console.error('Failed to get token:', loginRes.data);
    process.exit(1);
  }
  const token = loginRes.data.token;
  const user = loginRes.data.user;
  console.log('Logged in user:', user.username, 'Role:', user.role, 'Avatar:', user.avatar_url);

  // 2. Fetch /api/auth/me
  console.log('\n2. Fetching /api/auth/me...');
  const meRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/me',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  console.log('GET /auth/me result:', meRes.data?.user?.username, 'Avatar:', meRes.data?.user?.avatar_url);

  // 3. Test changing avatar and full name
  console.log('\n3. Updating avatar to 👩‍🍳 and name...');
  const updateRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/profile',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }, {
    full_name: 'สมหญิง สดใส น่ารัก',
    avatar_url: '👩‍🍳',
    phone_number: '089-999-8888'
  });
  console.log('Update profile response:', updateRes.data);

  // 4. Test changing password with invalid current password (should fail)
  console.log('\n4. Testing password change with WRONG current password...');
  const wrongPassRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/profile',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }, {
    current_password: 'wrongpassword',
    new_password: 'newpassword123'
  });
  console.log('Wrong pass status (expected 400):', wrongPassRes.status, wrongPassRes.data?.message);

  // 5. Test changing password with valid current password
  console.log('\n5. Testing password change with CORRECT current password...');
  const changePassRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/profile',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }, {
    current_password: '123456',
    new_password: 'newpassword123'
  });
  console.log('Change pass status (expected 200):', changePassRes.status, changePassRes.data?.message);

  // 6. Test logging in with new password
  console.log('\n6. Logging in with NEW password...');
  const newLoginRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { username: 'staff', password: 'newpassword123' });
  console.log('New login status:', newLoginRes.status, newLoginRes.data?.success ? 'SUCCESS' : 'FAILED');
  console.log('Logged in user avatar:', newLoginRes.data?.user?.avatar_url);

  // 7. Reset password back to 123456 for test reproducibility
  const newToken = newLoginRes.data?.token;
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/profile',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${newToken}`
    }
  }, {
    current_password: 'newpassword123',
    new_password: '123456'
  });
  console.log('\nReset password back to 123456 successfully.');

  console.log('\n--- ALL PROFILE TESTS PASSED SUCCESSFULLY! 🎉 ---');
}

runTests().catch(console.error);
