const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const { initDatabase } = require('./src/db');
const { initWebSocket } = require('./src/services/websocket');
const apiRoutes = require('./src/routes/api');

const app = express();
const server = http.createServer(app);

// Initialize WebSockets
initWebSocket(server);

// Middlewares
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

const uploadController = require('./src/controllers/uploadController');

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for /uploads when file is not cached locally (served from Neon Database)
app.get('/uploads/:folder/:filename', uploadController.getMediaByFolderAndFile);

// Mount API Routes
app.use('/api', apiRoutes);

// Friendly URL Rewrites for Portals
app.get('/order/:storeSlug/:qrToken', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.get(['/login', '/login.html'], (req, res) => {
  res.redirect('/?modal=login');
});

app.get(['/register', '/signup', '/register.html', '/signup.html'], (req, res) => {
  res.redirect('/?modal=register');
});

app.get(['/lineliff', '/liff', '/lineliff.html', '/liff.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lineliff.html'));
});

app.get(['/store', '/store-admin'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

app.get(['/superadmin', '/platform', '/platform-admin', '/superadmin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'superadmin.html'));
});

// Fallback to index.html
app.get('*', (req, res) => {
  if (req.accepts('html')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ success: false, message: 'Resource not found' });
  }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log('----------------------------------------------------');
  console.log(`✨ Server running smoothly at http://localhost:${PORT}`);
  console.log(`📱 Customer Demo QR Order: http://localhost:${PORT}/order/somtum-zaab/zaab-t01-abc1`);
  console.log(`🏪 Store Admin Portal:     http://localhost:${PORT}/store.html`);
  console.log(`👑 Super Admin Portal:     http://localhost:${PORT}/superadmin.html`);
  console.log(`🔐 Login & Register Modal:   http://localhost:${PORT}/?modal=login`);
  console.log('----------------------------------------------------');

  try {
    await initDatabase();
  } catch (err) {
    console.warn('[Database] Initial connection warning:', err.message);
  }
});

module.exports = app;
