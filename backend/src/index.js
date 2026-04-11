process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const purchasesRouter = require('./routes/purchases');
const productsRouter = require('./routes/products');
const syncRouter = require('./routes/sync');
const cogsRouter = require('./routes/cogs');
const journalRouter = require('./routes/journal');
const fulfillmentRouter = require('./routes/fulfillment');
const auspostRouter = require('./routes/auspost');
const redoRouter = require('./routes/redo');
const payoutsRouter = require('./routes/payouts');
const xeroRouter = require('./routes/xero');
const capitalExpensesRouter = require('./routes/capitalExpenses');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/purchases', purchasesRouter);
app.use('/api/products', productsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/cogs', cogsRouter);
app.use('/api', cogsRouter); // also mounts /api/inventory/summary from cogsRouter
app.use('/api/journal', journalRouter);
app.use('/api/fulfillment', fulfillmentRouter);
app.use('/api/3pl/auspost', auspostRouter);
app.use('/api/sync/redo', redoRouter);
app.use('/api/payouts', payoutsRouter);
app.use('/api/xero', xeroRouter);
app.use('/api/capital-expenses', capitalExpensesRouter);

// Root health check (Railway checks GET /)
app.get('/', (req, res) => res.json({ status: 'ok' }));

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
