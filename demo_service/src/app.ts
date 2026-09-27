import express, { Express, Request, Response, NextFunction } from 'express';
import { checkoutRouter } from './routes/checkout';
import { logger } from './utils/logger';

export const app: Express = express();

// Middleware
app.use(express.json());

// Health Check Endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'checkout-service',
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/api/checkout', checkoutRouter);

// Global Error Handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled application error', err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message,
  });
});

// Conditionally start HTTP server only when run directly (not when imported in tests)
if (require.main === module) {
  const PORT = Number(process.env.DEMO_SERVICE_PORT) || 3001;
  app.listen(PORT, () => {
    logger.info(`Checkout demo service listening on port ${PORT}`);
  });
}
