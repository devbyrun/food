const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, query } = require('../db');

// Ensure local upload directories exist for local cache/fallback
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
try {
  if (!fs.existsSync(LOCAL_UPLOADS_DIR)) {
    fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  }
} catch (e) {
  // Ignored in read-only serverless environments
}

/**
 * Checks if S3 / External Object Storage credentials and endpoint are properly configured
 */
function isS3Configured() {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return false;
  }

  if (
    accessKeyId.includes('<generated') ||
    secretAccessKey.includes('<generated') ||
    accessKeyId.trim() === '' ||
    secretAccessKey.trim() === ''
  ) {
    return false;
  }

  return true;
}

/**
 * Get configured S3 Client instance
 */
function getS3Client() {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_REGION || 'us-east-2';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  const config = {
    region,
    forcePathStyle: true,
  };

  if (endpoint) {
    config.endpoint = endpoint;
  }

  if (accessKeyId && secretAccessKey) {
    config.credentials = {
      accessKeyId,
      secretAccessKey,
    };
  }

  return new S3Client(config);
}

/**
 * Helper to determine file extension from MIME type
 */
function getExtensionFromMime(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || 'jpg';
}

/**
 * Upload a binary buffer to Cloud Storage (S3 / Neon PostgreSQL Database / Local Cache)
 * 
 * @param {Object} options
 * @param {Buffer} options.buffer - File buffer
 * @param {string} [options.key] - Storage key (path)
 * @param {string} [options.contentType] - MIME type
 * @param {string} [options.folder] - Target folder ('menus', 'logos', 'qrcodes', 'avatars', 'slips', 'uploads')
 * @param {string} [options.originalName] - Original filename
 * @returns {Promise<{ url: string, key: string, mediaId?: number, isS3: boolean, storageType: string }>}
 */
async function uploadBuffer({ buffer, key, contentType = 'image/jpeg', folder = 'uploads', originalName = '' }) {
  const bucket = process.env.AWS_S3_BUCKET || 'assets';
  const ext = originalName ? path.extname(originalName).replace('.', '') : getExtensionFromMime(contentType);
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const fileName = `${Date.now()}-${randomSuffix}.${ext}`;
  const finalKey = key || `${folder}/${fileName}`;

  // 1. Try S3 / Object Storage if configured
  if (isS3Configured()) {
    try {
      const s3 = getS3Client();
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        Body: buffer,
        ContentType: contentType,
      });

      await s3.send(command);

      let url;
      try {
        url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: finalKey }), {
          expiresIn: 60 * 60 * 24 * 7, // 7 days
        });
      } catch (signErr) {
        const endpoint = process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL;
        url = `${endpoint.replace(/\/$/, '')}/${bucket}/${finalKey}`;
      }

      console.log(`[Storage] Uploaded to S3 successfully: ${finalKey}`);
      return {
        success: true,
        url,
        key: finalKey,
        fileName,
        isS3: true,
        storageType: 's3',
      };
    } catch (s3Error) {
      console.warn(`[Storage] S3 upload failed (${s3Error.message}), falling back to Neon PostgreSQL Storage...`);
    }
  }

  // 2. Persistent Neon PostgreSQL Cloud Media Storage
  try {
    const insertRes = await query(
      `INSERT INTO uploaded_media (file_name, original_name, folder, mime_type, file_size, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, file_name, folder, mime_type, file_size, created_at`,
      [fileName, originalName || fileName, folder, contentType, buffer.length, buffer]
    );

    const savedMedia = insertRes.rows[0];
    const mediaUrl = `/api/media/${savedMedia.id}`;

    // Optional local cache copy (if writable)
    try {
      const targetSubDir = path.join(LOCAL_UPLOADS_DIR, folder);
      if (!fs.existsSync(targetSubDir)) {
        fs.mkdirSync(targetSubDir, { recursive: true });
      }
      const localFilePath = path.join(targetSubDir, fileName);
      fs.writeFileSync(localFilePath, buffer);
    } catch (localWriteErr) {
      // Non-fatal on serverless / Vercel
    }

    console.log(`[Storage] Saved persistently to Neon PostgreSQL DB: id=${savedMedia.id} url=${mediaUrl} (${buffer.length} bytes)`);

    return {
      success: true,
      url: mediaUrl,
      fallbackUrl: `/uploads/${folder}/${fileName}`,
      mediaId: savedMedia.id,
      key: finalKey,
      fileName,
      isS3: false,
      storageType: 'database',
    };
  } catch (dbError) {
    console.error(`[Storage] Database storage error:`, dbError.message);
  }

  // 3. Local filesystem fallback (Development only)
  try {
    const targetSubDir = path.join(LOCAL_UPLOADS_DIR, folder);
    if (!fs.existsSync(targetSubDir)) {
      fs.mkdirSync(targetSubDir, { recursive: true });
    }
    const filePath = path.join(targetSubDir, fileName);
    fs.writeFileSync(filePath, buffer);

    const localUrl = `/uploads/${folder}/${fileName}`;
    console.log(`[Storage] Saved to local storage: ${localUrl}`);

    return {
      success: true,
      url: localUrl,
      key: `local/${folder}/${fileName}`,
      fileName,
      isS3: false,
      storageType: 'local',
    };
  } catch (localErr) {
    throw new Error(`Failed to store image on both Database and Local Storage: ${localErr.message}`);
  }
}

/**
 * Upload a Base64 image string to Cloud Storage (Neon Database / S3 / Local)
 * 
 * @param {string} base64String - Data URL e.g. "data:image/jpeg;base64,/9j/4AAQSk..."
 * @param {string} [folder] - Subfolder
 * @returns {Promise<{ url: string, key: string, isS3: boolean, storageType: string }>}
 */
async function uploadBase64Image(base64String, folder = 'menus') {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('Invalid base64 string provided');
  }

  // If it's already an HTTP / HTTPS / /api/media / /uploads URL, return as is
  if (
    base64String.startsWith('http://') ||
    base64String.startsWith('https://') ||
    base64String.startsWith('/api/media/') ||
    base64String.startsWith('/uploads/')
  ) {
    return {
      success: true,
      url: base64String,
      key: base64String,
      isS3: false,
      storageType: 'existing',
    };
  }

  let contentType = 'image/jpeg';
  let pureBase64 = base64String;

  const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (matches && matches.length === 3) {
    contentType = matches[1];
    pureBase64 = matches[2];
  }

  const buffer = Buffer.from(pureBase64, 'base64');
  return uploadBuffer({ buffer, contentType, folder });
}

/**
 * Get media file from Neon PostgreSQL by Media ID
 */
async function getMediaById(id) {
  try {
    const res = await query(
      `SELECT id, file_name, original_name, folder, mime_type, file_size, data, created_at
       FROM uploaded_media
       WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Storage] Error fetching media by ID:', err.message);
    return null;
  }
}

/**
 * Get media file from Neon PostgreSQL by File Name or Folder/FileName
 */
async function getMediaByFileName(fileName, folder = null) {
  try {
    let sql = `SELECT id, file_name, original_name, folder, mime_type, file_size, data, created_at
               FROM uploaded_media
               WHERE file_name = $1`;
    const params = [fileName];

    if (folder) {
      sql += ` AND folder = $2`;
      params.push(folder);
    }

    const res = await query(sql, params);
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Storage] Error fetching media by file name:', err.message);
    return null;
  }
}

/**
 * Delete media file from Neon PostgreSQL & S3
 */
async function deleteMedia(idOrFileName) {
  try {
    let media = null;
    if (/^\d+$/.test(idOrFileName)) {
      media = await getMediaById(idOrFileName);
      await query(`DELETE FROM uploaded_media WHERE id = $1`, [idOrFileName]);
    } else {
      media = await getMediaByFileName(idOrFileName);
      await query(`DELETE FROM uploaded_media WHERE file_name = $1`, [idOrFileName]);
    }

    // Try deleting from S3 if configured
    if (media && isS3Configured()) {
      try {
        const s3 = getS3Client();
        const bucket = process.env.AWS_S3_BUCKET || 'assets';
        await s3.send(new DeleteObjectCommand({
          Bucket: bucket,
          Key: `${media.folder}/${media.file_name}`,
        }));
      } catch (s3Err) {
        console.warn('[Storage] S3 deletion warning:', s3Err.message);
      }
    }

    return true;
  } catch (err) {
    console.error('[Storage] Error deleting media:', err.message);
    return false;
  }
}

/**
 * Get storage configuration & stats
 */
async function getStorageStats() {
  let dbMediaCount = 0;
  let totalBytes = 0;
  let isDbConnected = false;

  try {
    const res = await query(`SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size FROM uploaded_media`);
    dbMediaCount = parseInt(res.rows[0].count, 10);
    totalBytes = parseInt(res.rows[0].total_size, 10);
    isDbConnected = true;
  } catch (err) {
    isDbConnected = false;
  }

  const isS3 = isS3Configured();

  return {
    isS3,
    isDatabaseConnected: isDbConnected,
    primaryStorage: isS3 ? 'AWS / Neon S3 Object Storage' : 'Neon PostgreSQL Cloud Media Storage',
    mediaCount: dbMediaCount,
    totalSizeBytes: totalBytes,
    totalSizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
    endpoint: process.env.AWS_ENDPOINT_URL_S3 || null,
    bucket: process.env.AWS_S3_BUCKET || 'assets',
    region: process.env.AWS_REGION || 'us-east-2',
  };
}

/**
 * Get signed presigned URL for a specific S3 key
 */
async function getPresignedUrl(key, expiresIn = 3600) {
  if (!isS3Configured()) {
    return null;
  }

  try {
    const s3 = getS3Client();
    const bucket = process.env.AWS_S3_BUCKET || 'assets';
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return await getSignedUrl(s3, command, { expiresIn });
  } catch (err) {
    console.error('[Storage] Error generating signed URL:', err);
    return null;
  }
}

module.exports = {
  isS3Configured,
  getS3Client,
  uploadBuffer,
  uploadBase64Image,
  getMediaById,
  getMediaByFileName,
  deleteMedia,
  getStorageStats,
  getPresignedUrl,
};
