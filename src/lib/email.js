/**
 * Email service using SendGrid API
 * Reliable email service for cloud deployments
 * Documentation: https://www.twilio.com/docs/sendgrid/for-developers/sending-email/quickstart-nodejs
 */

import sgMail from '@sendgrid/mail';
import dotenv from 'dotenv';

dotenv.config();

// SendGrid configuration from environment variables
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

// From email address
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || process.env.FROM_EMAIL;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || process.env.FROM_NAME || 'HireWise Team';

// Initialize SendGrid API key
let sendGridInitialized = false;

/**
 * Initialize SendGrid client
 */
function initializeSendGrid() {
  if (sendGridInitialized) {
    return true;
  }

  // Check if API key is provided
  if (!SENDGRID_API_KEY) {
    console.warn('[EMAIL] SendGrid API key not configured. Email sending will be disabled.');
    console.warn('[EMAIL] Set SENDGRID_API_KEY in .env file.');
    return false;
  }

  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
    sendGridInitialized = true;
    //sgMail.setDataResidency('eu'); 
    console.log('[EMAIL] SendGrid client initialized successfully');
    return true;
  } catch (error) {
    console.error('[EMAIL] Error initializing SendGrid client:', error);
    return false;
  }
}

/**
 * Verify SendGrid connection
 * Tests the API key configuration
 */
export async function verifyEmailConnection() {
  if (!initializeSendGrid()) {
    return { ok: false, error: 'SendGrid not configured' };
  }

  // Skip verification if disabled
  if (process.env.SENDGRID_SKIP_VERIFY === 'true') {
    console.log('[EMAIL] SendGrid verification skipped (SENDGRID_SKIP_VERIFY=true)');
    return { ok: true, skipped: true };
  }

  try {
    // SendGrid doesn't have a direct verify endpoint, so we just check if API key is set
    // The actual verification happens when sending the first email
    console.log('[EMAIL] SendGrid connection verified (API key configured)');
    return { ok: true };
  } catch (error) {
    console.error('[EMAIL] SendGrid verification failed:', error);
    
    // Provide helpful error messages
    let helpfulError = error.message;
    if (error.message?.includes('API key') || error.message?.includes('unauthorized')) {
      helpfulError = 'SendGrid API key is invalid. Please check SENDGRID_API_KEY in your .env file.';
    }
    
    return { ok: false, error: helpfulError };
  }
}

/**
 * Send email using SendGrid API
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email address (can be string or array)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML email body
 * @param {string} options.text - Plain text email body
 * @param {string} options.from - Optional sender email (defaults to SENDGRID_FROM_EMAIL)
 * @param {string|string[]} options.cc - Optional CC recipients
 * @param {string|string[]} options.bcc - Optional BCC recipients
 * @param {string} options.replyTo - Optional reply-to address
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, text, from, cc, bcc, replyTo }) {
  console.log(`[EMAIL] Sending email to ${Array.isArray(to) ? to.join(', ') : to}`);
  console.log(`[EMAIL] Subject: ${subject}`);

  if (!initializeSendGrid()) {
    console.error('[EMAIL] Cannot send email: SendGrid not configured');
    return {
      ok: false,
      error: 'SendGrid not configured. Please set SENDGRID_API_KEY in .env file.',
    };
  }

  // Validate required fields
  if (!to || !subject) {
    return {
      ok: false,
      error: 'to and subject are required',
    };
  }

  if (!FROM_EMAIL) {
    return {
      ok: false,
      error: 'SENDGRID_FROM_EMAIL is required. Please set it in .env file.',
    };
  }

  // Use provided from or default
  const fromEmail = from || FROM_EMAIL;
  const fromAddress = FROM_NAME ? `${FROM_NAME} <${fromEmail}>` : fromEmail;

  try {
    // Prepare message data for SendGrid
    const msg = {
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
    };

    // Add email body (prefer HTML, fallback to text)
    if (html) {
      msg.html = html;
      // Also include text version if provided, otherwise strip HTML
      msg.text = text || html.replace(/<[^>]*>/g, '');
    } else if (text) {
      msg.text = text;
    } else {
      return {
        ok: false,
        error: 'Either html or text content is required',
      };
    }

    // Add optional fields if provided
    if (cc) {
      msg.cc = Array.isArray(cc) ? cc : [cc];
    }
    if (bcc) {
      msg.bcc = Array.isArray(bcc) ? bcc : [bcc];
    }
    if (replyTo) {
      msg.replyTo = replyTo;
    }

    // Send email via SendGrid
    const response = await sgMail.send(msg);

    // SendGrid returns an array with status code and headers
    const statusCode = response[0]?.statusCode || 202;
    
    console.log(`[EMAIL] Email sent successfully. Status Code: ${statusCode}`);
    
    return {
      ok: true,
      id: response[0]?.headers?.['x-message-id'] || 'unknown',
      message: 'Email sent successfully',
      statusCode: statusCode,
    };
  } catch (error) {
    console.error('[EMAIL] Error sending email:', error);
    
    // Provide helpful error messages
    let errorMessage = error.message || 'Unknown error';
    
    // SendGrid error handling
    if (error.response) {
      const { statusCode, body } = error.response;
      
      if (statusCode === 401 || statusCode === 403) {
        errorMessage = 'SendGrid API key is invalid or unauthorized. Please check SENDGRID_API_KEY in your .env file.';
      } else if (statusCode === 400) {
        errorMessage = `Invalid email request: ${body?.errors?.[0]?.message || error.message}. Please check your email format and sender identity.`;
      } else if (statusCode === 413) {
        errorMessage = 'Email payload too large. Please reduce the email size.';
      } else if (statusCode === 429) {
        errorMessage = 'SendGrid rate limit exceeded. Please try again later.';
      } else {
        errorMessage = `SendGrid API error (${statusCode}): ${body?.errors?.[0]?.message || error.message}`;
      }
    } else if (error.message?.includes('API key') || error.message?.includes('unauthorized')) {
      errorMessage = 'SendGrid API key is invalid. Please check SENDGRID_API_KEY in your .env file.';
    } else if (error.message?.includes('sender identity') || error.message?.includes('from')) {
      errorMessage = `Invalid sender identity: ${fromEmail}. Please verify your sender identity in SendGrid dashboard.`;
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
  verifyEmailConnection().then(async result => {
    console.log('Email connection test:', result);
    const emailResult = await sendEmail({
      to: 'nikhil1.bansal@paytm.com',
      subject: 'Test Email',
      html: '<p>This is a test email from Resend</p>',
    });
    console.log('Email result:', emailResult);
    process.exit(result.ok ? 0 : 1);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}