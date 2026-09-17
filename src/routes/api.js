const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const customerController = require('../controllers/customerController');
const adminController = require('../controllers/adminController');
const platformController = require('../controllers/platformController');
const uploadController = require('../controllers/uploadController');
const { handleTelegramWebhook } = require('../services/telegram');
const { authenticateToken, requireRole } = require('../middlewares/auth');

// -------------------------------------------------------------
// 0. Image & File Upload Routes (Neon PostgreSQL Media & S3 Storage)
// -------------------------------------------------------------
router.post('/upload', uploadController.multerMiddleware, uploadController.uploadFile);
router.post('/upload/base64', uploadController.uploadBase64);
router.get('/upload/status', uploadController.getStorageStatus);
router.get('/media/:id', uploadController.getMediaFile);
router.get('/media/file/:filename', uploadController.getMediaByName);
router.get('/uploads/:folder/:filename', uploadController.getMediaByFolderAndFile);
router.delete('/media/:id', authenticateToken, uploadController.deleteMediaFile);

// -------------------------------------------------------------
// 1. Authentication Routes (Public & Protected)
// -------------------------------------------------------------
router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.get('/auth/me', authenticateToken, authController.getMe);
router.put('/auth/profile', authenticateToken, authController.updateProfile);

// -------------------------------------------------------------
// 2. Customer QR Ordering Routes (Public by QR Token)
// -------------------------------------------------------------
router.get('/customer/store/:storeSlug/table/:qrToken', customerController.getTableAndMenu);
router.post('/customer/store/:storeSlug/table/:qrToken/order', customerController.submitOrder);
router.get('/customer/order/:orderId/status', customerController.getOrderStatus);
router.post('/customer/store/:storeSlug/table/:qrToken/service-call', customerController.callService);

// -------------------------------------------------------------
// 3. Telegram Webhook Endpoint
// -------------------------------------------------------------
router.post('/telegram/webhook', async (req, res) => {
  try {
    await handleTelegramWebhook(req.body);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Telegram Webhook Error]:', err);
    return res.status(500).json({ ok: false });
  }
});

// -------------------------------------------------------------
// 4. Store Admin Routes (Manager & Staff)
// -------------------------------------------------------------
// Dashboard Metrics (Manager & Admin only)
router.get('/admin/dashboard', authenticateToken, requireRole(['admin', 'manager']), adminController.getDashboardMetrics);

// Tables, Zones & QR
router.get('/admin/tables', authenticateToken, adminController.getTables);
router.post('/admin/tables', authenticateToken, requireRole(['admin', 'manager']), adminController.createTable);
router.put('/admin/tables/:id', authenticateToken, adminController.updateTable);
router.delete('/admin/tables/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.deleteTable);

// Zone Management
router.get('/admin/zones', authenticateToken, adminController.getZones);
router.post('/admin/zones', authenticateToken, requireRole(['admin', 'manager']), adminController.createZone);
router.put('/admin/zones/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.updateZone);
router.delete('/admin/zones/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.deleteZone);

// Kitchen (KDS)
router.get('/admin/kitchen/orders', authenticateToken, adminController.getKitchenOrders);
router.put('/admin/kitchen/items/:itemId/status', authenticateToken, adminController.updateKitchenItemStatus);

// POS & Cashier
router.get('/admin/pos/table/:tableId', authenticateToken, adminController.getTableBill);
router.post('/admin/pos/order/:orderId/checkout', authenticateToken, adminController.checkoutOrder);

// Menus & Categories (Manager only)
router.get('/admin/menus', authenticateToken, requireRole(['admin', 'manager']), adminController.getMenus);
router.post('/admin/menus', authenticateToken, requireRole(['admin', 'manager']), adminController.createMenu);
router.put('/admin/menus/:menuId', authenticateToken, requireRole(['admin', 'manager']), adminController.updateMenu);
router.delete('/admin/menus/:menuId', authenticateToken, requireRole(['admin', 'manager']), adminController.deleteMenu);
router.put('/admin/menus/:menuId/toggle', authenticateToken, requireRole(['admin', 'manager']), adminController.toggleMenuAvailability);

// Reports (Manager only)
router.get('/admin/reports', authenticateToken, requireRole(['admin', 'manager']), adminController.getReports);
router.put('/admin/reports/transactions/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.updateTransaction);
router.delete('/admin/reports/transactions/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.deleteTransaction);

// Staff Management (Manager only)
router.get('/admin/staff', authenticateToken, requireRole(['admin', 'manager']), adminController.getStaffList);
router.post('/admin/staff', authenticateToken, requireRole(['admin', 'manager']), adminController.createStaff);
router.put('/admin/staff/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.updateStaff);
router.delete('/admin/staff/:id', authenticateToken, requireRole(['admin', 'manager']), adminController.deleteStaff);

// Settings & Telegram Config (Manager only)
router.get('/admin/settings', authenticateToken, requireRole(['admin', 'manager']), adminController.getSettings);
router.put('/admin/settings', authenticateToken, requireRole(['admin', 'manager']), adminController.updateSettings);
router.put('/admin/store/toggle-open', authenticateToken, requireRole(['admin', 'manager']), adminController.toggleStoreOpen);
router.post('/admin/telegram/test', authenticateToken, requireRole(['admin', 'manager']), adminController.testTelegram);
router.post('/admin/telegram/simulate-callback', authenticateToken, adminController.simulateTelegramCallback);
router.post('/admin/telegram/clear-simulated', authenticateToken, adminController.clearTelegramSimulation);

// -------------------------------------------------------------
// 5. Platform Super Admin Routes & Public Trial
// -------------------------------------------------------------
// Public Free Trial Signup (Landing Page)
router.post('/platform/trial-signup', platformController.trialSignup);

// Super Admin Protected Routes
router.get('/platform/overview', authenticateToken, requireRole('admin'), platformController.getPlatformOverview);
router.post('/platform/stores', authenticateToken, requireRole('admin'), platformController.createStore);
router.put('/platform/stores/:id', authenticateToken, requireRole('admin'), platformController.updateStore);
router.delete('/platform/stores/:id', authenticateToken, requireRole('admin'), platformController.deleteStore);
router.get('/platform/analytics/sales', authenticateToken, requireRole('admin'), platformController.getSalesAnalytics);

// Platform Users Management (Super Admin only)
router.get('/platform/users', authenticateToken, requireRole('admin'), platformController.getPlatformUsers);
router.post('/platform/users', authenticateToken, requireRole('admin'), platformController.createPlatformUser);
router.put('/platform/users/:id', authenticateToken, requireRole('admin'), platformController.updatePlatformUser);
router.delete('/platform/users/:id', authenticateToken, requireRole('admin'), platformController.deletePlatformUser);

// Subscription Plans Management (Public & Super Admin)
router.get('/platform/plans', platformController.getSubscriptionPlans);
router.get('/platform/admin/plans', authenticateToken, requireRole('admin'), platformController.getAllSubscriptionPlansAdmin);
router.post('/platform/admin/plans', authenticateToken, requireRole('admin'), platformController.createSubscriptionPlan);
router.put('/platform/admin/plans/:id', authenticateToken, requireRole('admin'), platformController.updateSubscriptionPlan);
router.delete('/platform/admin/plans/:id', authenticateToken, requireRole('admin'), platformController.deleteSubscriptionPlan);

module.exports = router;

