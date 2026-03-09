require('dotenv').config();
const express = require('express');
const cors = require('cors');

const purchasesRouter = require('./routes/purchases');
const productsRouter = require('./routes/products');
const syncRouter = require('./routes/sync');
const cogsRouter = require('./routes/cogs');
const journalRouter = require('./routes/journal');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// Routes
app.use('/api/purchases', purchasesRouter);
app.use('/api/products', productsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/cogs', cogsRouter);
app.use('/api/journal', journalRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, () => {
  console.log(`Watch Box COGS backend running on port ${PORT}`);
});

module.exports = app;
