import fs from 'fs';
import crypto from 'crypto';
import https from 'https';

const key = JSON.parse(fs.readFileSync('D:/FIREBASE/Backend/firebase-sa-key.json', 'utf8'));

// Step 1: Create JWT assertion
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', typ: 'JWT' };
const payload = {
  iss: key.client_email,
  sub: key.client_email,
  scope: 'https://www.googleapis.com/auth/analytics.readonly',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600
};

function b64(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

const signingInput = b64(header) + '.' + b64(payload);
const sign = crypto.createSign('RSA-SHA256');
sign.update(signingInput);
const signature = sign.sign(key.private_key, 'base64url');
const jwt = signingInput + '.' + signature;

// Step 2: Exchange for access token
function post(url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers,
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(new Error(body)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Get token
  const params = new URLSearchParams();
  params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.set('assertion', jwt);
  
  const tokenRes = await post(
    'https://oauth2.googleapis.com/token',
    params.toString(),
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  
  if (!tokenRes.access_token) {
    console.error('Token error:', JSON.stringify(tokenRes));
    return;
  }
  
  const accessToken = tokenRes.access_token;
  
  // Query GA4 - last 30 days
  const query = {
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    metrics: [
      { name: 'activeUsers' },
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'screenPageViews' },
      { name: 'averageSessionDuration' },
      { name: 'engagedSessions' }
    ],
    dimensions: [{ name: 'date' }]
  };
  
  const gaRes = await post(
    'https://analyticsdata.googleapis.com/v1beta/properties/540437738:runReport',
    JSON.stringify(query),
    {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    }
  );
  
  console.log(JSON.stringify(gaRes, null, 2));
}

main().catch(e => console.error(e));
