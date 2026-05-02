/**
 * XRP Music - Video Upload to Filecoin S3
 * Generates presigned URLs for direct browser → Filecoin uploads
 * Bypasses Lighthouse completely for videos
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  region: process.env.FILONE_REGION,
  endpoint: process.env.FILONE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.FILONE_ACCESS_KEY_ID,
    secretAccessKey: process.env.FILONE_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  // CORS
  const allowedOrigins = [
    'https://musicugc.com',
    'https://www.xrpmusic.io',
    'https://music-x-khaki.vercel.app/',
    'http://localhost:3000',
    'http://localhost:5500',
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fileName, fileType } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ error: 'fileName and fileType required' });
    }

    // Generate unique key (timestamp + sanitized filename)
    const timestamp = Date.now();
    const sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `videos/${timestamp}_${sanitized}`;

    // Create presigned URL for browser upload
    const command = new PutObjectCommand({
      Bucket: process.env.FILONE_BUCKET,
      Key: key,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    // Construct the final public URL
    const publicUrl = `${process.env.FILONE_ENDPOINT}/${process.env.FILONE_BUCKET}/${key}`;

    console.log('✅ Generated Filecoin upload URL for:', fileName);

    res.status(200).json({
      success: true,
      uploadUrl,
      publicUrl,
      key,
    });
  } catch (error) {
    console.error('❌ Filecoin upload URL generation failed:', error);
    res.status(500).json({ error: error.message });
  }
}
