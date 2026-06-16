// src/utils/sms.js
// SMS utility using MSG91 API (https://msg91.com)

const https = require('https');

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

/**
 * Send an OTP SMS via MSG91 Send OTP API.
 *
 * @param {string} phone - 10-digit Indian mobile number (without +91)
 * @param {string} otp - The OTP code to send
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function sendOtpSms(phone, otp) {
  if (!MSG91_AUTH_KEY) {
    console.warn('[SMS] MSG91_AUTH_KEY not set — skipping SMS send');
    return { success: false, message: 'SMS API key not configured' };
  }

  if (!MSG91_TEMPLATE_ID) {
    console.warn('[SMS] MSG91_TEMPLATE_ID not set — skipping SMS send');
    return { success: false, message: 'SMS template ID not configured' };
  }

  // Strip +91 or 91 prefix if present, keep only 10 digits
  const cleanPhone = phone.replace(/^\+?91/, '').replace(/\D/g, '');
  if (cleanPhone.length !== 10) {
    return { success: false, message: 'Invalid phone number — must be 10 digits' };
  }

  // MSG91 expects phone with country code (91XXXXXXXXXX)
  const fullPhone = `91${cleanPhone}`;

  return new Promise((resolve) => {
    const options = {
      hostname: 'control.msg91.com',
      path: `/api/v5/otp?template_id=${MSG91_TEMPLATE_ID}&mobile=${fullPhone}&otp=${otp}`,
      method: 'POST',
      headers: {
        'authkey': MSG91_AUTH_KEY,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.type === 'success' || json.type === 'Success') {
            console.log(`[SMS] OTP sent to ${cleanPhone} via MSG91`);
            resolve({ success: true, message: 'OTP sent successfully' });
          } else {
            console.error('[SMS] MSG91 error:', json.message || data);
            resolve({ success: false, message: json.message || 'Failed to send OTP' });
          }
        } catch (e) {
          console.error('[SMS] Parse error:', e.message, 'Raw:', data);
          resolve({ success: false, message: 'SMS service error' });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[SMS] Request error:', e.message);
      resolve({ success: false, message: 'SMS service unavailable' });
    });

    req.end();
  });
}

/**
 * Verify OTP via MSG91 Verify API (optional — use if you want MSG91 to manage OTP state).
 * Currently unused since we manage OTP verification in our own DB.
 *
 * @param {string} phone - 10-digit Indian mobile number (without +91)
 * @param {string} otp - The OTP code to verify
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function verifyOtpViaMSG91(phone, otp) {
  if (!MSG91_AUTH_KEY) {
    return { success: false, message: 'SMS API key not configured' };
  }

  const cleanPhone = phone.replace(/^\+?91/, '').replace(/\D/g, '');
  const fullPhone = `91${cleanPhone}`;

  return new Promise((resolve) => {
    const options = {
      hostname: 'control.msg91.com',
      path: `/api/v5/otp/verify?mobile=${fullPhone}&otp=${otp}`,
      method: 'GET',
      headers: {
        'authkey': MSG91_AUTH_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.type === 'success' || json.type === 'Success') {
            resolve({ success: true, message: 'OTP verified' });
          } else {
            resolve({ success: false, message: json.message || 'OTP verification failed' });
          }
        } catch (e) {
          resolve({ success: false, message: 'SMS service error' });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, message: 'SMS service unavailable' });
    });

    req.end();
  });
}

/**
 * Resend OTP via MSG91 Retry API.
 *
 * @param {string} phone - 10-digit Indian mobile number (without +91)
 * @param {string} retryType - 'text' for SMS, 'voice' for voice call
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function resendOtpViaMSG91(phone, retryType = 'text') {
  if (!MSG91_AUTH_KEY) {
    return { success: false, message: 'SMS API key not configured' };
  }

  const cleanPhone = phone.replace(/^\+?91/, '').replace(/\D/g, '');
  const fullPhone = `91${cleanPhone}`;

  return new Promise((resolve) => {
    const options = {
      hostname: 'control.msg91.com',
      path: `/api/v5/otp/retry?mobile=${fullPhone}&retrytype=${retryType}`,
      method: 'POST',
      headers: {
        'authkey': MSG91_AUTH_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.type === 'success' || json.type === 'Success') {
            resolve({ success: true, message: 'OTP resent successfully' });
          } else {
            resolve({ success: false, message: json.message || 'Failed to resend OTP' });
          }
        } catch (e) {
          resolve({ success: false, message: 'SMS service error' });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, message: 'SMS service unavailable' });
    });

    req.end();
  });
}

module.exports = { sendOtpSms, verifyOtpViaMSG91, resendOtpViaMSG91 };
