import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_DIR = path.join(__dirname, '../../tmp_uploads');

/**
 * Ensure upload directory exists
 */
async function ensureUploadDir() {
  try {
    await fs.access(UPLOAD_DIR);
  } catch {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * Save uploaded file to tmp_uploads directory
 * @param {Object} file - Multer file object
 * @returns {Promise<string>} - Path to saved file
 */
export async function saveUploadedFile(file) {
  await ensureUploadDir();

  const timestamp = Date.now();
  const filename = `${timestamp}-${file.originalname}`;
  const filepath = path.join(UPLOAD_DIR, filename);

  await fs.writeFile(filepath, file.buffer);

  return filepath;
}

/**
 * Read file content as text (for text files)
 * @param {string} filepath - Path to file
 * @returns {Promise<string>} - File content
 */
export async function readFileAsText(filepath) {
  try {
    const content = await fs.readFile(filepath, 'utf-8');
    return content;
  } catch (error) {
    console.error(`Error reading file ${filepath}:`, error);
    return '';
  }
}

