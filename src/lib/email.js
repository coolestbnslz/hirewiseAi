/**
 * Email service using Mailgun API
 * More reliable for cloud deployments like Railway
 */

import FormData from 'form-data';
import Mailgun from 'mailgun.js';
import dotenv from 'dotenv';

dotenv.config();

// Mailgun configuration from environment variables
const MAILGUN_CONFIG = {
  apiKey: process.env.MAILGUN_API_KEY || process.env.API_KEY,
  domain: process.env.MAILGUN_DOMAIN,
  // For EU domains, use: https://api.eu.mailgun.net
  url: process.env.MAILGUN_URL || 'https://api.mailgun.net', // Default US, use 'https://api.eu.mailgun.net' for EU
};

// From email address
const FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
const FROM_NAME = process.env.MAILGUN_FROM_NAME || process.env.SMTP_FROM_NAME || 'HireWise';

// Create reusable Mailgun client
let mailgunClient = null;

/**
 * Initialize Mailgun client
 */
function getMailgunClient() {
  if (mailgunClient) {
    return mailgunClient;
  }

  // Check if credentials are provided
  if (!MAILGUN_CONFIG.apiKey || !MAILGUN_CONFIG.domain) {
    console.warn('[EMAIL] Mailgun credentials not configured. Email sending will be disabled.');
    console.warn('[EMAIL] Set MAILGUN_API_KEY and MAILGUN_DOMAIN in .env file.');
    return null;
  }

  try {
    const mailgun = new Mailgun(FormData);
    mailgunClient = mailgun.client({
      username: 'api',
      key: MAILGUN_CONFIG.apiKey,
      url: MAILGUN_CONFIG.url, // US or EU endpoint
    });

    console.log(`[EMAIL] Mailgun client configured for domain: ${MAILGUN_CONFIG.domain}`);
    if (MAILGUN_CONFIG.url.includes('eu.mailgun.net')) {
      console.log('[EMAIL] Using EU Mailgun endpoint');
    }
    return mailgunClient;
  } catch (error) {
    console.error('[EMAIL] Error creating Mailgun client:', error);
    return null;
  }
}

/**
 * Verify Mailgun connection
 * Tests the API key and domain configuration
 */
export async function verifyEmailConnection() {
  const client = getMailgunClient();
  if (!client) {
    return { ok: false, error: 'Mailgun not configured' };
  }

  // Skip verification if disabled
  if (process.env.MAILGUN_SKIP_VERIFY === 'true') {
    console.log('[EMAIL] Mailgun verification skipped (MAILGUN_SKIP_VERIFY=true)');
    return { ok: true, skipped: true };
  }

  try {
    // Test by getting domain info (lightweight API call)
    const verifyTimeout = parseInt(process.env.MAILGUN_VERIFY_TIMEOUT) || 5000; // 5 seconds default
    
    const verifyPromise = client.domains.get(MAILGUN_CONFIG.domain);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Verification timeout')), verifyTimeout)
    );
    
    await Promise.race([verifyPromise, timeoutPromise]);
    console.log('[EMAIL] Mailgun connection verified successfully');
    return { ok: true };
  } catch (error) {
    console.error('[EMAIL] Mailgun verification failed:', error);
    
    // Provide helpful error messages
    let helpfulError = error.message;
    if (error.status === 401 || error.statusCode === 401) {
      helpfulError = 'Mailgun API key is invalid. Please check MAILGUN_API_KEY in your .env file.';
    } else if (error.status === 404 || error.statusCode === 404) {
      helpfulError = `Mailgun domain "${MAILGUN_CONFIG.domain}" not found. Please check MAILGUN_DOMAIN in your .env file.`;
    } else if (error.message.includes('timeout')) {
      helpfulError = 'Mailgun API request timed out. This is usually a network issue.';
    }
    
    return { ok: false, error: helpfulError };
  }
}

/**
 * Send email using Mailgun API
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email address (can be string or array)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML email body
 * @param {string} options.text - Plain text email body
 * @param {string} options.from - Optional sender email (defaults to MAILGUN_FROM_EMAIL)
 * @param {string|string[]} options.cc - Optional CC recipients
 * @param {string|string[]} options.bcc - Optional BCC recipients
 * @param {string} options.replyTo - Optional reply-to address
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, text, from, cc, bcc, replyTo }) {
  console.log(`[EMAIL] Sending email to ${Array.isArray(to) ? to.join(', ') : to}`);
  console.log(`[EMAIL] Subject: ${subject}`);

  const client = getMailgunClient();
  if (!client) {
    console.error('[EMAIL] Cannot send email: Mailgun not configured');
    return {
      ok: false,
      error: 'Mailgun not configured. Please set MAILGUN_API_KEY and MAILGUN_DOMAIN in .env file.',
    };
  }

  // Validate required fields
  if (!to || !subject) {
    return {
      ok: false,
      error: 'to and subject are required',
    };
  }

  if (!MAILGUN_CONFIG.domain) {
    return {
      ok: false,
      error: 'MAILGUN_DOMAIN is required',
    };
  }

  // Use provided from or default
  const fromEmail = from || FROM_EMAIL || `noreply@${MAILGUN_CONFIG.domain}`;
  const fromAddress = FROM_NAME ? `${FROM_NAME} <${fromEmail}>` : fromEmail;

  try {
    // Prepare message data
    const messageData = {
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
    };

    // Add email body (prefer HTML, fallback to text)
    if (html) {
      messageData.html = html;
      // Also include text version if provided, otherwise strip HTML
      messageData.text = text || html.replace(/<[^>]*>/g, '');
    } else if (text) {
      messageData.text = text;
    } else {
      return {
        ok: false,
        error: 'Either html or text content is required',
      };
    }

    // Add optional fields if provided
    if (cc) {
      messageData.cc = Array.isArray(cc) ? cc : [cc];
    }
    if (bcc) {
      messageData.bcc = Array.isArray(bcc) ? bcc : [bcc];
    }
    if (replyTo) {
      messageData['h:Reply-To'] = replyTo;
    }

    // Send email via Mailgun
    const data = await client.messages.create(MAILGUN_CONFIG.domain, messageData);

    console.log(`[EMAIL] Email sent successfully. Message ID: ${data.id}`);
    
    return {
      ok: true,
      id: data.id,
      message: data.message,
    };
  } catch (error) {
    console.error('[EMAIL] Error sending email:', error);
    
    // Provide helpful error messages
    let errorMessage = error.message;
    if (error.status === 401 || error.statusCode === 401) {
      errorMessage = 'Mailgun API key is invalid. Please check MAILGUN_API_KEY in your .env file.';
    } else if (error.status === 402 || error.statusCode === 402) {
      errorMessage = 'Mailgun payment required. Please check your Mailgun account billing.';
    } else if (error.status === 404 || error.statusCode === 404) {
      errorMessage = `Mailgun domain "${MAILGUN_CONFIG.domain}" not found. Please check MAILGUN_DOMAIN in your .env file.`;
    } else if (error.status === 400 || error.statusCode === 400) {
      errorMessage = `Invalid email request: ${error.message}. Please check your email format.`;
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