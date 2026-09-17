const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const { initDatabase } = require('../src/db');
const apiRoutes = require('../src/routes/api');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

// Database connection & migrations check (cached per serverless container)
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await initDatabase();
      dbInitialized = true;
    } catch (err) {
      console.warn('[Database Vercel Init Warning]:', err.message);
    }
  }
  next();
});

const uploadController = require('../src/controllers/uploadController');

// Mount API Routes
app.use('/api', apiRoutes);

// Fallback for /uploads when served through Vercel Serverless
app.get('/uploads/:folder/:filename', uploadController.getMediaByFolderAndFile);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

module.exports = app;
