const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Determine User Data Path (Same logic as server/index.js)
const APP_DATA_DIR = process.env.USER_DATA_PATH || path.join(os.homedir(), '.webdav-client');
// Ensure directory exists (sync is fine here as it's startup)
if (!fs.existsSync(APP_DATA_DIR)) {
    try {
        fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    } catch (e) {
        console.error('Failed to create config dir:', e);
    }
}

const SECRET_FILE = path.join(APP_DATA_DIR, '.secret.key');
console.log('[Server] Crypto Key Path:', SECRET_FILE);
const ALGORITHM = 'aes-256-cbc';

// Ensure we have a persistent secret key
let SECRET_KEY;
if (fs.existsSync(SECRET_FILE)) {
    SECRET_KEY = Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8'), 'hex');
} else {
    SECRET_KEY = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, SECRET_KEY.toString('hex'));
}

const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return text;
    try {
        const textParts = text.split(':');
        if (textParts.length !== 2) return text; // Return original if not formatted
        const iv = Buffer.from(textParts[0], 'hex');
        const encryptedText = Buffer.from(textParts[1], 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        console.error('Decryption failed:', e.message);
        return text; // Fallback to original (in case of legacy plain text)
    }
}

module.exports = { encrypt, decrypt };
