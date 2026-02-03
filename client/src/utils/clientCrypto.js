import CryptoJS from 'crypto-js';

// Hardcoded key for obfuscation/basic encryption on mobile
// Prevents plain text leakage in SharedPreferences/UserDefaults
const SECRET_KEY = 'WebDavClient-Mobile-Secure-Key-ChangeMeIfYouCan'; 

export const encrypt = (text) => {
    if (!text) return text;
    try {
        return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
    } catch (e) {
        console.error('Encrypt failed', e);
        return text;
    }
};

export const decrypt = (text) => {
    if (!text) return text;
    try {
        const bytes = CryptoJS.AES.decrypt(text, SECRET_KEY);
        const originalText = bytes.toString(CryptoJS.enc.Utf8);
        return originalText || text; // Fallback to text if empty (decrypt failed logic sometimes)
    } catch (e) {
        // console.error('Decrypt failed', e); // Silent fail for legacy plain text
        return text; // Return original if not encrypted
    }
};
