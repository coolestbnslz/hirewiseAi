import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/database.js';
import { verifyEmailConnection } from './lib/email.js';
import jobsRouter from './routes/jobs.js';
import applicationsRouter from './routes/applications.js';
import screeningsRouter from './routes/screenings.js';
import usersRouter from './routes/users.js';
import debugRouter from './routes/debug.js';
import analysisRouter from './routes/analysis.js';
import emailRouter from './routes/email.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/jobs', jobsRouter);
app.use('/api/apply', applicationsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/screenings', screeningsRouter);
app.use('/api/users', usersRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/email', emailRouter);
app.use('/debug', debugRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Start server
async function startServer() {
  try {
    await connectDB();
    
    // Verify email connection (non-blocking, with timeout)
    // Skip verification in cloud environments if SENDGRID_SKIP_VERIFY is set
    if (process.env.SENDGRID_SKIP_VERIFY !== 'true') {
      const verifyPromise = verifyEmailConnection();
      const timeoutPromise = new Promise((resolve) => 
        setTimeout(() => resolve({ ok: false, error: 'Verification timeout (skipped)' }), 3000)
      );
      
      Promise.race([verifyPromise, timeoutPromise]).then(result => {
        if (result.ok) {
          console.log('[Server] ✅ Email service ready');
        } else {
          if (result.skipped) {
            console.log('[Server] ℹ️  Email verification skipped');
          } else {
            console.warn('[Server] ⚠️  Email service not configured or connection failed');
            // Only show detailed error if it's not just missing credentials
            if (result.error && !result.error.includes('not configured') && !result.error.includes('timeout')) {
              console.warn('[Server] Error:', result.error);
            } else if (result.error && result.error.includes('timeout')) {
              console.warn('[Server] SendGrid connection timeout. Set SENDGRID_SKIP_VERIFY=true to skip verification.');
            } else {
              console.warn('[Server] Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL in .env to enable email sending');
            }
          }
        }
      }).catch(err => {
        console.warn('[Server] Email verification error:', err.message);
        console.warn('[Server] Email sending may still work. Set SENDGRID_SKIP_VERIFY=true to skip verification.');
      });
    } else {
      console.log('[Server] ℹ️  Email verification skipped (SENDGRID_SKIP_VERIFY=true)');
    }
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

