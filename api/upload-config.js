/**
 * XRP Music - Upload Config API
 * Returns Lighthouse API key for direct browser uploads
 * Also returns Reown project ID for WalletConnect (Bifrost)
 * Security: Only allows requests from your domain
 */
export default async function handler(req, res) {
  // CORS - restrict to your domains
  const allowedOrigins = [
    'https://musicugc.com',
    'https://www.xrpmusic.io',
    'music-x-khaki.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Check referer as additional security
  const referer = req.headers.referer || '';
  const isValidReferer = allowedOrigins.some(o => referer.startsWith(o));
  
  if (!isValidReferer && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Invalid request origin' });
  }
  
  const lighthouseApiKey = process.env.LIGHTHOUSE_API_KEY;
  if (!lighthouseApiKey) {
    return res.status(500).json({ error: 'Upload service not configured' });
  }
  
  return res.json({
    key: lighthouseApiKey,
    endpoint: 'https://upload.lighthouse.storage/api/v0/add',
    reownProjectId: process.env.REOWN_PROJECT_ID,
  });
}
