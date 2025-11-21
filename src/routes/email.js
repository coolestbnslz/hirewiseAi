import express from 'express';
import User from '../models/User.js';
import { sendEmail } from '../lib/email.js';

const router = express.Router();

/**
 * POST /api/email/send - Send email with content from request
 * If required fields are missing, fetch them from User collection
 * 
 * Request body:
 * {
 *   "to": "recipient@example.com",  // Optional if userId provided
 *   "userId": "user_id_here",        // Optional - to fetch email from User
 *   "subject": "Email Subject",      // Required
 *   "html": "<h1>HTML Content</h1>", // Optional (either html or text required)
 *   "text": "Plain text content",    // Optional (either html or text required)
 *   "cc": "cc@example.com",          // Optional
 *   "bcc": "bcc@example.com",        // Optional
 *   "replyTo": "reply@example.com"   // Optional
 * }
 */
router.post('/send', async (req, res) => {
  try {
    const { to, userId, subject, html, text, cc, bcc, replyTo } = req.body;

    // Validate subject (required)
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return res.status(400).json({ error: 'subject is required and must be a non-empty string' });
    }

    // Determine recipient email
    let recipientEmail = to;

    // If to is not provided, try to get from userId
    if (!recipientEmail && userId) {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (!user.email) {
        return res.status(400).json({ error: 'User does not have an email address' });
      }
      recipientEmail = user.email;
      console.log(`[Email] Using email from User collection: ${recipientEmail}`);
    }

    // Validate recipient email
    if (!recipientEmail || typeof recipientEmail !== 'string' || recipientEmail.trim().length === 0) {
      return res.status(400).json({ 
        error: 'to (recipient email) is required. Provide either "to" or "userId" in request body' 
      });
    }

    // Validate email format (basic validation)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipientEmail.trim())) {
      return res.status(400).json({ error: 'Invalid email format for recipient' });
    }

    // Validate that at least html or text is provided
    if ((!html || html.trim().length === 0) && (!text || text.trim().length === 0)) {
      return res.status(400).json({ 
        error: 'Either "html" or "text" email body is required' 
      });
    }

    // Prepare email options
    const emailOptions = {
      to: recipientEmail.trim(),
      subject: subject.trim(),
      html: html ? html.trim() : undefined,
      text: text ? text.trim() : undefined,
    };

    // Add optional fields if provided
    if (cc) emailOptions.cc = cc;
    if (bcc) emailOptions.bcc = bcc;
    if (replyTo) emailOptions.replyTo = replyTo;

    // Send email
    const result = await sendEmail(emailOptions);

    if (!result.ok) {
      return res.status(500).json({
        error: 'Failed to send email',
        details: result.error,
      });
    }

    res.json({
      message: 'Email sent successfully',
      messageId: result.id,
      to: recipientEmail,
      subject: subject,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * POST /api/email/send-bulk - Send email to multiple recipients
 * 
 * Request body:
 * {
 *   "recipients": ["email1@example.com", "email2@example.com"], // Or user IDs
 *   "userIds": ["user_id_1", "user_id_2"],                       // Optional - to fetch emails
 *   "subject": "Email Subject",
 *   "html": "<h1>HTML Content</h1>",
 *   "text": "Plain text content"
 * }
 */
router.post('/send-bulk', async (req, res) => {
  try {
    const { recipients, userIds, subject, html, text } = req.body;

    // Validate subject
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return res.status(400).json({ error: 'subject is required' });
    }

    // Validate that at least html or text is provided
    if ((!html || html.trim().length === 0) && (!text || text.trim().length === 0)) {
      return res.status(400).json({ error: 'Either "html" or "text" email body is required' });
    }

    // Collect all recipient emails
    let recipientEmails = [];

    // Add emails from recipients array
    if (recipients && Array.isArray(recipients)) {
      recipientEmails.push(...recipients.filter(email => typeof email === 'string'));
    }

    // Fetch emails from userIds if provided
    if (userIds && Array.isArray(userIds) && userIds.length > 0) {
      const users = await User.find({ _id: { $in: userIds } });
      const userEmails = users
        .filter(user => user.email)
        .map(user => user.email);
      recipientEmails.push(...userEmails);
      console.log(`[Email] Fetched ${userEmails.length} emails from User collection`);
    }

    // Remove duplicates and validate
    recipientEmails = [...new Set(recipientEmails.map(email => email.trim().toLowerCase()))];

    if (recipientEmails.length === 0) {
      return res.status(400).json({ 
        error: 'No valid recipient emails found. Provide either "recipients" array or "userIds" array' 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = recipientEmails.filter(email => emailRegex.test(email));
    
    if (validEmails.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found' });
    }

    // Send emails to all recipients
    const results = await Promise.allSettled(
      validEmails.map(email => 
        sendEmail({
          to: email,
          subject: subject.trim(),
          html: html ? html.trim() : undefined,
          text: text ? text.trim() : undefined,
        })
      )
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length;

    res.json({
      message: `Email sending completed: ${successful} successful, ${failed} failed`,
      totalRecipients: validEmails.length,
      successful,
      failed,
      recipients: validEmails,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error sending bulk email:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

