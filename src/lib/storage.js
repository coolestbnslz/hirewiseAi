import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_DIR = path.join(__dirname, '../../tmp_uploads');

// S3 Configuration
const S3_CONFIG = {
  region: process.env.AWS_S3_REGION || process.env.AWS_REGION || 'us-east-1', // Use AWS_S3_REGION if set, otherwise fallback to AWS_REGION
  bucket: process.env.AWS_S3_BUCKET_NAME,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

// Initialize S3 client if credentials are provided
let s3Client = null;
if (S3_CONFIG.accessKeyId && S3_CONFIG.secretAccessKey && S3_CONFIG.bucket) {
  s3Client = new S3Client({
    region: S3_CONFIG.region,
    credentials: {
      accessKeyId: S3_CONFIG.accessKeyId,
      secretAccessKey: S3_CONFIG.secretAccessKey,
    },
  });
  console.log(`[Storage] S3 client initialized for region: ${S3_CONFIG.region}, bucket: ${S3_CONFIG.bucket}`);
} else {
  console.warn('[Storage] S3 credentials not configured. Resumes will be stored locally.');
  console.warn('[Storage] Set AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY in .env file.');
  console.warn('[Storage] Optionally set AWS_S3_REGION if your S3 bucket is in a different region than Bedrock.');
}

/**
 * Ensure upload directory exists (for local fallback)
 */
async function ensureUploadDir() {
  try {
    await fs.access(UPLOAD_DIR);
  } catch {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * Save uploaded file to S3 (or local storage as fallback)
 * @param {Object} file - Multer file object
 * @returns {Promise<string>} - S3 URL or local file path
 */
export async function saveUploadedFile(file) {
  // If S3 is configured, upload to S3
  if (s3Client && S3_CONFIG.bucket) {
    try {
      const timestamp = Date.now();
      const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const s3Key = `resumes/${timestamp}-${sanitizedFilename}`;
      
      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: S3_CONFIG.bucket,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/pdf',
        // Make file publicly readable (or use signed URLs if you prefer)
        // ACL: 'public-read', // Uncomment if you want public access
      });

      await s3Client.send(command);

      // Generate S3 URL
      const s3Url = `https://${S3_CONFIG.bucket}.s3.${S3_CONFIG.region}.amazonaws.com/${s3Key}`;
      
      console.log(`[Storage] File uploaded to S3: ${s3Url}`);
      return s3Url;
    } catch (error) {
      console.error('[Storage] Error uploading to S3, falling back to local storage:', error);
      // Fall back to local storage if S3 upload fails
    }
  }

  // Fallback to local storage
  await ensureUploadDir();
  const timestamp = Date.now();
  const filename = `${timestamp}-${file.originalname}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  await fs.writeFile(filepath, file.buffer);
  console.log(`[Storage] File saved locally: ${filepath}`);
  return filepath;
}

/**
 * Read file content as text (supports PDF and text files)
 * Supports both S3 URLs and local file paths
 * @param {string} filepathOrUrl - S3 URL or local file path
 * @returns {Promise<string>} - File content as text
 */
export async function readFileAsText(filepathOrUrl) {
  try {
    let buffer;
    let ext;

    // Check if it's an S3 URL
    if (filepathOrUrl && filepathOrUrl.startsWith('https://') && filepathOrUrl.includes('.s3.')) {
      // It's an S3 URL
      if (!s3Client || !S3_CONFIG.bucket) {
        throw new Error('S3 not configured but S3 URL provided');
      }

      // Extract bucket and key from URL
      // Format: https://bucket-name.s3.region.amazonaws.com/key
      const urlMatch = filepathOrUrl.match(/https:\/\/([^\.]+)\.s3[^\/]+\/(.+)/);
      if (!urlMatch) {
        throw new Error('Invalid S3 URL format');
      }

      const bucket = urlMatch[1];
      const key = decodeURIComponent(urlMatch[2]);

      // Download from S3
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await s3Client.send(command);
      const chunks = [];
      
      // Convert stream to buffer
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
      
      ext = path.extname(key).toLowerCase();
      console.log(`[Storage] Downloaded file from S3: ${key}`);
    } else {
      // It's a local file path
      buffer = await fs.readFile(filepathOrUrl);
      ext = path.extname(filepathOrUrl).toLowerCase();
    }
    
    // Handle PDF files
    if (ext === '.pdf') {
      const parser = new PDFParse({ data: buffer });
      const textResult = await parser.getText();
      const text = textResult.text.trim();
      
      // Clean up parser resources
      await parser.destroy();
      
      console.log(`[Storage] Extracted ${text.length} characters from PDF`);
      if (text.length < 100) {
        console.warn(`[Storage] Warning: PDF extraction resulted in very little text (${text.length} chars). The PDF might be image-based or corrupted.`);
      }
      
      return text;
    }
    
    // Handle text files
    const content = buffer.toString('utf-8');
    return content;
  } catch (error) {
    console.error(`[Storage] Error reading file ${filepathOrUrl}:`, error);
    return '';
  }
}

/**
 * Generate a presigned URL for an S3 object
 * @param {string} s3Url - Full S3 URL (e.g., https://bucket.s3.region.amazonaws.com/key)
 * @param {number} expiresIn - URL expiration time in seconds (default: 3600 = 1 hour)
 * @returns {Promise<string>} - Presigned URL
 */
export async function getPresignedUrl(s3Url, expiresIn = 3600) {
  if (!s3Client || !S3_CONFIG.bucket) {
    throw new Error('S3 not configured');
  }

  // Extract bucket and key from URL
  // Format: https://bucket-name.s3.region.amazonaws.com/key
  const urlMatch = s3Url.match(/https:\/\/([^\.]+)\.s3[^\/]+\/(.+)/);
  if (!urlMatch) {
    throw new Error('Invalid S3 URL format');
  }

  const bucket = urlMatch[1];
  const key = decodeURIComponent(urlMatch[2]);

  // Create GetObjectCommand
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  // Generate presigned URL
  const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
  
  console.log(`[Storage] Generated presigned URL for ${key} (expires in ${expiresIn}s)`);
  return presignedUrl;
}

