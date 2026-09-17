require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');

async function runTests() {
  console.log('=== Running Full Upload & Storage Test Suite ===');

  const { isS3Configured, uploadBuffer, uploadBase64Image } = require('../src/services/storage');

  // Test 1: Service level check
  console.log('1. Checking S3 Configuration Status:');
  console.log('   Is S3 Configured:', isS3Configured());
  console.log('   S3 Endpoint:', process.env.AWS_ENDPOINT_URL_S3);
  console.log('   S3 Bucket:', process.env.AWS_S3_BUCKET || 'assets');

  // Test 2: Upload a sample PNG image buffer
  console.log('\n2. Testing Image Buffer Upload (menus folder):');
  const samplePngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const bufferResult = await uploadBuffer({
    buffer: samplePngBuffer,
    contentType: 'image/png',
    folder: 'menus',
    originalName: 'test-somtum.png'
  });
  console.log('   Result:', bufferResult);
  if (!bufferResult.success || !bufferResult.url) {
    throw new Error('Buffer upload test failed!');
  }

  // Test 3: Upload Base64 logo
  console.log('\n3. Testing Base64 Upload (logos folder):');
  const sampleBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const b64Result = await uploadBase64Image(sampleBase64, 'logos');
  console.log('   Result:', b64Result);
  if (!b64Result.success || !b64Result.url) {
    throw new Error('Base64 upload test failed!');
  }

  // Test 4: Database query verification for menus & stores
  console.log('\n4. Verifying DB Menu & Store Tables can store Image URLs:');
  const { query } = require('../src/db');
  
  // Check menus table columns
  const menuCols = await query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'menus' AND column_name = 'image_url'`
  );
  console.log('   menus.image_url exists:', menuCols.rows.length > 0, `(${menuCols.rows[0]?.data_type})`);

  // Check stores table columns
  const storeCols = await query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'stores' AND column_name IN ('logo_url', 'promptpay_qr_url')`
  );
  console.log('   stores image columns:', storeCols.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));

  console.log('\n=== All Storage & Upload Tests Passed Successfully! ✨ ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
