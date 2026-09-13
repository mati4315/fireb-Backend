import { Readable } from 'node:stream';
import { getHostingFtpConfig, loadFtpClient, loadSharp, sanitizePathSegment } from './hostingUtils';

const TARGET_HOSTS = new Set([
  'arribanoticias.com.ar',
  'www.arribanoticias.com.ar',
  'elmiercolesdigital.com.ar',
  'www.elmiercolesdigital.com.ar'
]);
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_QUALITY = 72;

const getArgentinaWeekStart = (now: Date): Date => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const getPart = (type: string): number => Number(parts.find((part) => part.type === type)?.value || 0);
  const localMidnightUtc = new Date(Date.UTC(getPart('year'), getPart('month') - 1, getPart('day'), 3));
  const daysSinceMonday = (localMidnightUtc.getUTCDay() + 6) % 7;
  localMidnightUtc.setUTCDate(localMidnightUtc.getUTCDate() - daysSinceMonday);
  return localMidnightUtc;
};

export const isOfficialThumbnailSource = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    return TARGET_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
};

export const isCurrentWeekOrFuture = (publishedAt: Date | null, now = new Date()): boolean => {
  return (publishedAt || now).getTime() >= getArgentinaWeekStart(now).getTime();
};

const safeNewsId = (newsId: string): string =>
  sanitizePathSegment(newsId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'news';

const safeSourceName = (sourceUrl: string): string => {
  try {
    return sanitizePathSegment(new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ''));
  } catch {
    return 'official';
  }
};

export const createOfficialNewsThumbnail = async (options: {
  newsId: string;
  sourceUrl: string;
  primaryImageUrl: string;
  publishedAt: Date | null;
}): Promise<string | null> => {
  if (
    !isOfficialThumbnailSource(options.sourceUrl) ||
    !options.primaryImageUrl ||
    !isCurrentWeekOrFuture(options.publishedAt)
  ) {
    return null;
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(options.primaryImageUrl);
    if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  try {
    const response = await fetch(imageUrl, {
      headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`source-image-http-${response.status}`);

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_SOURCE_BYTES) throw new Error('source-image-too-large');

    const sourceBuffer = Buffer.from(await response.arrayBuffer());
    if (sourceBuffer.length === 0 || sourceBuffer.length > MAX_SOURCE_BYTES) {
      throw new Error('source-image-invalid-size');
    }

    const sharp = await loadSharp();
    const thumbnailBuffer = await sharp(sourceBuffer)
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY, effort: 4 })
      .toBuffer();

    const relativePath = `news-thumbnails/${safeSourceName(options.sourceUrl)}/${safeNewsId(options.newsId)}.webp`;
    const config = getHostingFtpConfig();
    const remotePath = `${config.basePath}/${relativePath}`.replace(/\/+/g, '/');
    const remoteDir = remotePath.slice(0, remotePath.lastIndexOf('/'));
    const { Client } = await loadFtpClient();
    const ftpClient = new Client(30_000);
    ftpClient.ftp.verbose = false;

    try {
      await ftpClient.access({
        host: config.host,
        user: config.user,
        password: config.password,
        port: config.port,
        secure: false
      });
      await ftpClient.ensureDir(remoteDir);
      await ftpClient.uploadFrom(Readable.from(thumbnailBuffer), remotePath);
    } finally {
      ftpClient.close();
    }

    console.log('Official news thumbnail generated', {
      newsId: options.newsId,
      sourceHost: new URL(options.sourceUrl).hostname,
      sizeBytes: thumbnailBuffer.length,
      relativePath
    });
    return `${config.publicBaseUrl}/${relativePath}`;
  } catch (error) {
    console.error('Official news thumbnail generation failed', {
      newsId: options.newsId,
      sourceUrl: options.sourceUrl,
      error
    });
    return null;
  }
};
