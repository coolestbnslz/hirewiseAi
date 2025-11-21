/**
 * Phone number formatter for E.164 format
 * E.164 format: +[country code][number] (e.g., +919876543210)
 * No spaces, dashes, or other characters allowed
 */

/**
 * Format phone number to E.164 format
 * @param {string} phoneNumber - Phone number in any format
 * @param {string} defaultCountryCode - Default country code if not provided (default: '91' for India)
 * @returns {string} Phone number in E.164 format
 */
export function formatToE164(phoneNumber, defaultCountryCode = '91') {
  if (!phoneNumber) {
    throw new Error('Phone number is required');
  }

  // Remove all non-digit characters except +
  let cleaned = phoneNumber.trim().replace(/[^\d+]/g, '');

  // If already starts with +, validate and return
  if (cleaned.startsWith('+')) {
    // Remove + to process
    cleaned = cleaned.substring(1);
    
    // Ensure it's all digits after +
    if (!/^\d+$/.test(cleaned)) {
      throw new Error(`Invalid phone number format: ${phoneNumber}`);
    }
    
    // E.164 requires at least country code (1-3 digits) + number
    if (cleaned.length < 8) {
      throw new Error(`Phone number too short for E.164 format: ${phoneNumber}`);
    }
    
    return `+${cleaned}`;
  }

  // If no +, assume we need to add country code
  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, '');
  
  // Check if it already starts with country code
  if (cleaned.startsWith(defaultCountryCode)) {
    return `+${cleaned}`;
  }
  
  // Add default country code
  return `+${defaultCountryCode}${cleaned}`;
}

/**
 * Validate E.164 format
 * @param {string} phoneNumber - Phone number to validate
 * @returns {boolean} True if valid E.164 format
 */
export function isValidE164(phoneNumber) {
  if (!phoneNumber) return false;
  
  // E.164 format: + followed by 1-15 digits
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(phoneNumber);
}

/**
 * Format phone number with validation
 * @param {string} phoneNumber - Phone number in any format
 * @param {string} defaultCountryCode - Default country code (default: '91' for India)
 * @returns {string} Phone number in E.164 format
 * @throws {Error} If phone number cannot be formatted or is invalid
 */
export function formatPhoneNumber(phoneNumber, defaultCountryCode = '91') {
  const formatted = formatToE164(phoneNumber, defaultCountryCode);
  
  if (!isValidE164(formatted)) {
    throw new Error(`Invalid E.164 format: ${formatted}`);
  }
  
  return formatted;
}

