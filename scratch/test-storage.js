require('dotenv').config();
const storage = require('../src/services/storage');

async function testStorage() {
  console.log('--- Testing S3 Storage Service ---');
  console.log('Is S3 Configured:', storage.isS3Configured());

  // Test buffer upload (a simple 1x1 png or text test)
  const testBuffer = Buffer.from('Hello S3 Storage Test!');
  try {
    const res = await storage.uploadBuffer({
      buffer: testBuffer,
      contentType: 'text/plain',
      folder: 'test',
      originalName: 'test.txt'
    });
    console.log('Buffer Upload Result:', res);
  } catch (e) {
    console.error('Buffer Upload Error:', e);
  }

  // Test base64 image upload
  const dummyBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  try {
    const b64Res = await storage.uploadBase64Image(dummyBase64, 'menus');
    console.log('Base64 Upload Result:', b64Res);
  } catch (e) {
    console.error('Base64 Upload Error:', e);
  }

  console.log('--- Storage Test Completed ---');
}

testStorage();
