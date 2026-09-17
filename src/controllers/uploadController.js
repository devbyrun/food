const multer = require('multer');
const path = require('path');
const fs = require('fs');
const storage = require('../services/storage');

// Memory storage for multer (holds uploaded file in memory Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // Max 15MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('ไฟล์ที่อัปโหลดต้องเป็นรูปภาพเท่านั้น (JPG, PNG, WEBP, GIF, SVG)'), false);
    }
  },
});

/**
 * Handle multipart form-data file upload
 */
async function uploadFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'กรุณาเลือกไฟล์รูปภาพที่ต้องการอัปโหลด' });
    }

    const folder = req.body.folder || 'menus';
    const allowedFolders = ['menus', 'logos', 'qrcodes', 'avatars', 'slips', 'uploads'];
    const targetFolder = allowedFolders.includes(folder) ? folder : 'uploads';

    const result = await storage.uploadBuffer({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
      folder: targetFolder,
    });

    return res.json({
      success: true,
      message: 'อัปโหลดรูปภาพสำเร็จ',
      url: result.url,
      fallbackUrl: result.fallbackUrl || result.url,
      mediaId: result.mediaId,
      key: result.key,
      fileName: result.fileName,
      isS3: result.isS3,
      storageType: result.storageType,
    });
  } catch (err) {
    console.error('[UploadController Error]:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'เกิดข้อผิดพลาดในการอัปโหลดไฟล์',
    });
  }
}

/**
 * Handle Base64 encoded image upload
 */
async function uploadBase64(req, res) {
  try {
    const { image, folder = 'menus' } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุข้อมูลรูปภาพ Base64' });
    }

    const allowedFolders = ['menus', 'logos', 'qrcodes', 'avatars', 'slips', 'uploads'];
    const targetFolder = allowedFolders.includes(folder) ? folder : 'uploads';

    const result = await storage.uploadBase64Image(image, targetFolder);

    return res.json({
      success: true,
      message: 'บันทึกรูปภาพสำเร็จ',
      url: result.url,
      fallbackUrl: result.fallbackUrl || result.url,
      mediaId: result.mediaId,
      key: result.key,
      fileName: result.fileName,
      isS3: result.isS3,
      storageType: result.storageType,
    });
  } catch (err) {
    console.error('[UploadBase64 Error]:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'เกิดข้อผิดพลาดในการบันทึกรูปภาพ',
    });
  }
}

/**
 * Serve media file by ID (GET /api/media/:id)
 */
async function getMediaFile(req, res) {
  try {
    const { id } = req.params;
    if (!id || !/^\d+$/.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid media ID' });
    }

    const media = await storage.getMediaById(id);
    if (!media || !media.data) {
      return res.status(404).send('Image not found');
    }

    // Caching ETag & If-None-Match
    const etag = `W/"media-${media.id}-${new Date(media.created_at).getTime()}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', media.mime_type || 'image/jpeg');
    res.setHeader('Content-Length', media.data.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);

    return res.end(media.data);
  } catch (err) {
    console.error('[GetMediaFile Error]:', err);
    return res.status(500).send('Error retrieving media');
  }
}

/**
 * Serve media file by filename (GET /api/media/file/:filename)
 */
async function getMediaByName(req, res) {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).send('Filename required');
    }

    const media = await storage.getMediaByFileName(filename);
    if (!media || !media.data) {
      return res.status(404).send('Image not found');
    }

    const etag = `W/"file-${media.id}-${new Date(media.created_at).getTime()}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', media.mime_type || 'image/jpeg');
    res.setHeader('Content-Length', media.data.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);

    return res.end(media.data);
  } catch (err) {
    console.error('[GetMediaByName Error]:', err);
    return res.status(500).send('Error retrieving media');
  }
}

/**
 * Serve media by folder and filename (GET /uploads/:folder/:filename)
 * Fallback for direct /uploads/... requests if not on disk
 */
async function getMediaByFolderAndFile(req, res) {
  try {
    const { folder, filename } = req.params;

    // 1. Check if file physically exists on local disk first
    const localPath = path.join(__dirname, '..', '..', 'public', 'uploads', folder, filename);
    if (fs.existsSync(localPath)) {
      return res.sendFile(localPath);
    }

    // 2. Fallback to Neon PostgreSQL Database
    const media = await storage.getMediaByFileName(filename, folder);
    if (media && media.data) {
      const etag = `W/"folder-${media.id}-${new Date(media.created_at).getTime()}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.setHeader('Content-Type', media.mime_type || 'image/jpeg');
      res.setHeader('Content-Length', media.data.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('ETag', etag);
      return res.end(media.data);
    }

    return res.status(404).send('File not found');
  } catch (err) {
    console.error('[GetMediaByFolderAndFile Error]:', err);
    return res.status(500).send('Error retrieving media');
  }
}

/**
 * Delete media file
 */
async function deleteMediaFile(req, res) {
  try {
    const { id } = req.params;
    const ok = await storage.deleteMedia(id);
    if (ok) {
      return res.json({ success: true, message: 'ลบไฟล์รูปภาพสำเร็จ' });
    }
    return res.status(404).json({ success: false, message: 'ไม่พบไฟล์รูปภาพที่ต้องการลบ' });
  } catch (err) {
    console.error('[DeleteMedia Error]:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบไฟล์' });
  }
}

/**
 * Check storage status & configuration
 */
async function getStorageStatus(req, res) {
  try {
    const stats = await storage.getStorageStats();
    return res.json({
      success: true,
      ...stats,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
}

module.exports = {
  multerMiddleware: upload.single('file'),
  uploadFile,
  uploadBase64,
  getMediaFile,
  getMediaByName,
  getMediaByFolderAndFile,
  deleteMediaFile,
  getStorageStatus,
};
