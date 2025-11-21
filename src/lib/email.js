/**
 * Email service using SMTP with username/password authentication
 * Supports Gmail, Outlook, custom SMTP servers, etc.
 */

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// SMTP configuration from environment variables
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USERNAME,
    pass: process.env.SMTP_PASSWORD,
  },
};

// From email address (defaults to username if not set)
const FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_CONFIG.auth.user;
const FROM_NAME = process.env.SMTP_FROM_NAME || 'HireWise';

// Create reusable transporter
let transporter = null;

/**
 * Initialize email transporter
 */
function getTransporter() {
  if (transporter) {
    return transporter;
  }

  // Check if credentials are provided
  if (!SMTP_CONFIG.auth.user || !SMTP_CONFIG.auth.pass) {
    console.warn('[EMAIL] SMTP credentials not configured. Email sending will be disabled.');
    console.warn('[EMAIL] Set SMTP_USERNAME and SMTP_PASSWORD in .env file.');
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host: SMTP_CONFIG.host,
      port: SMTP_CONFIG.port,
      secure: SMTP_CONFIG.secure,
      auth: {
        user: SMTP_CONFIG.auth.user,
        pass: SMTP_CONFIG.auth.pass,
      },
      // Additional options for better compatibility
      tls: {
        rejectUnauthorized: false, // For self-signed certificates
      },
    });

    console.log(`[EMAIL] SMTP transporter configured for ${SMTP_CONFIG.host}:${SMTP_CONFIG.port}`);
    return transporter;
  } catch (error) {
    console.error('[EMAIL] Error creating transporter:', error);
    return null;
  }
}

/**
 * Verify SMTP connection
 */
export async function verifyEmailConnection() {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'SMTP not configured' };
  }

  try {
    await transporter.verify();
    console.log('[EMAIL] SMTP connection verified successfully');
    return { ok: true };
  } catch (error) {
    console.error('[EMAIL] SMTP verification failed:', error);
    
    // Provide helpful error messages for common issues
    let helpfulError = error.message;
    if (error.code === 'EAUTH' || error.responseCode === 535) {
      if (SMTP_CONFIG.host === 'smtp.gmail.com') {
        helpfulError = 'Gmail authentication failed. You need to use an App Password, not your regular Gmail password.\n' +
          'Steps to fix:\n' +
          '1. Enable 2-Factor Authentication on your Google Account\n' +
          '2. Go to Google Account → Security → 2-Step Verification → App passwords\n' +
          '3. Generate a new App Password for "Mail"\n' +
          '4. Use the 16-character App Password in SMTP_PASSWORD (not your regular password)';
      } else {
        helpfulError = 'SMTP authentication failed. Please check your username and password.';
      }
    }
    
    return { ok: false, error: helpfulError };
  }
}

/**
 * Send email using SMTP
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML email body
 * @param {string} options.text - Plain text email body
 * @param {string} options.from - Optional sender email (defaults to SMTP_FROM_EMAIL)
 * @param {string|string[]} options.cc - Optional CC recipients
 * @param {string|string[]} options.bcc - Optional BCC recipients
 * @param {string} options.replyTo - Optional reply-to address
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, text, from, cc, bcc, replyTo }) {
  console.log(`[EMAIL] Sending email to ${to}`);
  console.log(`[EMAIL] Subject: ${subject}`);

  const transporter = getTransporter();
  if (!transporter) {
    console.error('[EMAIL] Cannot send email: SMTP not configured');
    return {
      ok: false,
      error: 'SMTP not configured. Please set SMTP_USERNAME and SMTP_PASSWORD in .env file.',
    };
  }

  // Validate required fields
  if (!to || !subject) {
    return {
      ok: false,
      error: 'to and subject are required',
    };
  }

  // Use provided from or default
  const fromEmail = from || FROM_EMAIL;
  const fromAddress = FROM_NAME ? `${FROM_NAME} <${fromEmail}>` : fromEmail;

  try {
    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      text: text || html?.replace(/<[^>]*>/g, ''), // Strip HTML if no text provided
      html: html || text, // Use text as HTML if no HTML provided
    };

    // Add optional fields if provided
    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (replyTo) mailOptions.replyTo = replyTo;

    const info = await transporter.sendMail(mailOptions);

    console.log(`[EMAIL] Email sent successfully. Message ID: ${info.messageId}`);
    
    return {
      ok: true,
      id: info.messageId,
      response: info.response,
    };
  } catch (error) {
    console.error('[EMAIL] Error sending email:', error);
    
    // Provide helpful error messages
    let errorMessage = error.message;
    if (error.code === 'EAUTH' || error.responseCode === 535) {
      if (SMTP_CONFIG.host === 'smtp.gmail.com') {
        errorMessage = 'Gmail authentication failed. You need to use an App Password, not your regular Gmail password.\n' +
          'Steps to fix:\n' +
          '1. Enable 2-Factor Authentication on your Google Account\n' +
          '2. Go to Google Account → Security → 2-Step Verification → App passwords\n' +
          '3. Generate a new App Password for "Mail"\n' +
          '4. Use the 16-character App Password in SMTP_PASSWORD (not your regular password)';
      } else {
        errorMessage = 'SMTP authentication failed. Please check your username and password.';
      }
    } else if (error.code === 'ECONNECTION') {
      errorMessage = `Cannot connect to SMTP server ${SMTP_CONFIG.host}:${SMTP_CONFIG.port}. Check your SMTP settings.`;
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'SMTP connection timed out. Check your network and SMTP settings.';
    }

    return {
      ok: false,
      error: errorMessage,
    };
  }
}

// Test email connection (run with: node src/lib/email.js)
// Check if this file is being run directly (ES modules)
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                      process.argv[1]?.endsWith('email.js');

if (isMainModule) {
  verifyEmailConnection().then(result => {
    console.log('Email connection test:', result);
    process.exit(result.ok ? 0 : 1);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}