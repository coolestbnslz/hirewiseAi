import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';

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
 * Read file content as text (supports PDF and text files)
 * @param {string} filepath - Path to file
 * @returns {Promise<string>} - File content as text
 */
export async function readFileAsText(filepath) {
  try {
    const ext = path.extname(filepath).toLowerCase();
    
    // Handle PDF files
    if (ext === '.pdf') {
      const dataBuffer = await fs.readFile(filepath);
      const parser = new PDFParse({ data: dataBuffer });
      const textResult = await parser.getText();
      const text = textResult.text.trim();
      
      // Clean up parser resources
      await parser.destroy();
      
      console.log(`[Storage] Extracted ${text.length} characters from PDF: ${path.basename(filepath)}`);
      if (text.length < 100) {
        console.warn(`[Storage] Warning: PDF extraction resulted in very little text (${text.length} chars). The PDF might be image-based or corrupted.`);
      }
      
      return text;
    }
    
    // Handle text files
    const content = await fs.readFile(filepath, 'utf-8');
    return content;
  } catch (error) {
    console.error(`[Storage] Error reading file ${filepath}:`, error);
    return '';
  }
}

