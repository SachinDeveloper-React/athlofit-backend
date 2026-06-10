// src/utils/sms.js
// SMS utility using Fast2SMS API (https://www.fast2sms.com)

const https = require('https');

const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;
const FAST2SMS_BASE_URL = 'www.fast2sms.com';

/**
 * Send an OTP SMS via Fast2SMS DLT route.
 * Uses the "Quick Transactional SMS" (route: 'otp') method.
 *
 * @param {string} phone - 10-digit Indian mobile number (without +91)
 * @param {string} otp - The OTP code to send
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function sendOtpSms(phone, otp) {
  if (!FAST2SMS_API_KEY) {
    console.warn('[SMS] FAST2SMS_API_KEY not set — skipping SMS send');
    return { success: false, message: 'SMS API key not configured' };
  }

  // Strip +91 or 91 prefix if present, keep only 10 digits
  const cleanPhone = phone.replace(/^\+?91/, '').replace(/\D/g, '');
  if (cleanPhone.length !== 10) {
    return { success: false, message: 'Invalid phone number — must be 10 digits' };
  }

  const payload = JSON.stringify({
    route: 'otp',
    variables_values: otp,
    numbers: cleanPhone,
  });

  return new Promise((resolve) => {
    const options = {
      hostname: FAST2SMS_BASE_URL,
      path: '/bulkV2/message',
      method: 'POST',
      headers: {
        'authorization': FAST2SMS_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.return === true || json.status_code === 200) {
            console.log(`[SMS] OTP sent to ${cleanPhone}`);
            resolve({ success: true, message: 'OTP sent successfully' });
          } else {
            console.error('[SMS] Fast2SMS error:', json.message || data);
            resolve({ success: false, message: json.message || 'Failed to send OTP' });
          }
        } catch (e) {
          console.error('[SMS] Parse error:', e.message);
          resolve({ success: false, message: 'SMS service error' });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[SMS] Request error:', e.message);
      resolve({ success: false, message: 'SMS service unavailable' });
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { sendOtpSms };
