import * as functions from 'firebase-functions';
import * as path from 'path';
import type { DocumentData } from 'firebase-admin/firestore';
import { sanitizeBoundedString } from './userUtils';

export type HostingFtpClient = {
  ftp: { verbose: boolean };
  access(options: {
    host: string;
    user: string;
    password: string;
    port: number;
    secure: boolean;
  }): Promise<void>;
  ensureDir(path: string): Promise<void>;
  uploadFrom(source: NodeJS.ReadableStream, remotePath: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
  close(): void;
};

const MAX_HOSTING_UPLOAD_BYTES = 6 * 1024 * 1024;

export const loadFtpClient = async (): Promise<{ Client: new (timeoutMs?: number) => HostingFtpClient }> => {
  const ftpModule = await import('basic-ftp');
  return (ftpModule as unknown as {
    Client?: new (timeoutMs?: number) => HostingFtpClient;
    default?: { Client: new (timeoutMs?: number) => HostingFtpClient };
  }).default
    ? (ftpModule as unknown as { default: { Client: new (timeoutMs?: number) => HostingFtpClient } }).default
    : (ftpModule as unknown as { Client: new (timeoutMs?: number) => HostingFtpClient });
};

export const loadSharp = async (): Promise<any> => {
  const sharpModule = await import('sharp');
  return (sharpModule as any).default ?? sharpModule;
};

export const sanitizeOptionalUrl = (value: unknown, fieldName: string): string => {
  const raw = sanitizeBoundedString(value, 240);
  if (!raw) return '';

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported-protocol');
    }
    return parsed.toString().slice(0, 240);
  } catch {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `${fieldName} debe ser una URL valida (http/https).`
    );
  }
};

export const ensureImageMime = (value: unknown): string => {
  const mime = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!mime.startsWith('image/')) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Formato de archivo invalido.'
    );
  }
  return mime;
};

export const decodeBase64Payload = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se recibio imagen.'
    );
  }

  const sanitized = value.replace(/^data:[^;]+;base64,/, '').trim();
  const buffer = Buffer.from(sanitized, 'base64');
  if (buffer.length === 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se pudo decodificar la imagen.'
    );
  }
  if (buffer.length > MAX_HOSTING_UPLOAD_BYTES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'La imagen supera el limite permitido.'
    );
  }
  return buffer;
};

export const sanitizePathSegment = (value: string): string => {
  return value
    .replace(/[^a-zA-Z0-9/_.-]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
};

export const getHostingFtpConfig = () => {
  const host = process.env.HOSTING_FTP_HOST || '';
  const user = process.env.HOSTING_FTP_USER || '';
  const password = process.env.HOSTING_FTP_PASSWORD || '';
  const basePath = process.env.HOSTING_FTP_BASE_PATH || '/domains/bot.cdelu.io/public_html/images';
  const publicBaseUrl = process.env.HOSTING_PUBLIC_BASE_URL || 'https://bot.cdelu.io/images';
  const port = Number(process.env.HOSTING_FTP_PORT || 21);

  if (!host || !user || !password) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Falta configurar credenciales FTP del hosting.'
    );
  }

  return {
    host,
    user,
    password,
    port: Number.isFinite(port) ? port : 21,
    basePath,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, '')
  };
};

export const getHostingAvatarFtpConfig = () => {
  const host = process.env.HOSTING_FTP_HOST || '';
  const user = process.env.HOSTING_FTP_USER || '';
  const password = process.env.HOSTING_FTP_PASSWORD || '';
  const basePath = process.env.HOSTING_FTP_AVATAR_BASE_PATH || '/domains/bot.cdelu.io/public_html';
  const publicBaseUrl = process.env.HOSTING_AVATAR_PUBLIC_BASE_URL || 'https://bot.cdelu.io';
  const port = Number(process.env.HOSTING_FTP_PORT || 21);

  if (!host || !user || !password) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Falta configurar credenciales FTP del hosting.'
    );
  }

  return {
    host,
    user,
    password,
    port: Number.isFinite(port) ? port : 21,
    basePath,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, '')
  };
};

export const normalizeHostedRelativePath = (value: string): string => {
  return value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
};

export const extractHostedRelativePaths = (value: unknown, publicBaseUrl: string): string[] => {
  const results = new Set<string>();
  const publicBase = publicBaseUrl.replace(/\/+$/, '');

  const pushPath = (candidate: string) => {
    const normalized = normalizeHostedRelativePath(candidate);
    if (!normalized || normalized.includes('..')) return;
    results.add(normalized.replace(/^avatars\//i, 'AVATAR/'));
  };

  const pushFromString = (raw: string) => {
    const value = raw.trim();
    if (!value) return;

    const directPath = normalizeHostedRelativePath(value);
    if (/^(posts|AVATAR|avatars)\//i.test(directPath)) {
      pushPath(directPath);
      return;
    }

    if (/^https?:\/\//i.test(value)) {
      try {
        const urlObj = new URL(value);
        const baseObj = new URL(publicBase);
        if (urlObj.origin !== baseObj.origin) return;

        const basePath = normalizeHostedRelativePath(baseObj.pathname);
        let relativePath = normalizeHostedRelativePath(urlObj.pathname);

        if (basePath && relativePath.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)) {
          relativePath = relativePath.slice(basePath.length + 1);
        } else if (relativePath.toLowerCase().startsWith('images/')) {
          relativePath = relativePath.slice('images/'.length);
        } else if (relativePath.toLowerCase().startsWith('imagenes/')) {
          relativePath = relativePath.slice('imagenes/'.length);
        }

        if (relativePath) {
          pushPath(decodeURIComponent(relativePath));
        }
      } catch {
        const base = publicBase.replace(/\/+$/, '');
        if (value.startsWith(`${base}/`)) {
          pushPath(decodeURIComponent(value.slice(base.length + 1)));
        }
      }
    }
  };

  const visit = (entry: unknown) => {
    if (!entry) return;

    if (typeof entry === 'string') {
      pushFromString(entry);
      return;
    }

    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }

    if (typeof entry === 'object') {
      const imageEntry = entry as Record<string, unknown>;
      if (typeof imageEntry.path === 'string') {
        pushPath(imageEntry.path);
      }
      if (typeof imageEntry.thumbPath === 'string') {
        pushPath(imageEntry.thumbPath);
      }
      if (typeof imageEntry.url === 'string') {
        pushFromString(imageEntry.url);
      }

      for (const value of Object.values(imageEntry)) {
        visit(value);
      }
    }
  };

  visit(value);
  return Array.from(results);
};

export const buildHostingPathSet = (entries: Array<string | undefined>): Set<string> => {
  return new Set(entries.filter((entry): entry is string => typeof entry === 'string' && !!entry));
};

export const markHostingDocPaths = (
  set: Set<string>,
  docData: DocumentData
): void => {
  if (typeof docData.path === 'string') set.add(normalizeHostedRelativePath(docData.path));
  if (typeof docData.thumbPath === 'string') set.add(normalizeHostedRelativePath(docData.thumbPath));
};

export const deriveHostingThumbRelativePath = (relativePath: string): string | null => {
  const normalized = normalizeHostedRelativePath(relativePath);
  if (!normalized) return null;

  const ext = path.posix.extname(normalized);
  if (!ext) return null;

  const dir = path.posix.dirname(normalized);
  const baseName = path.posix.basename(normalized, ext);

  if (baseName.endsWith('_t') || baseName.endsWith('_') || baseName.endsWith('-thumb')) {
    return normalized;
  }

  if (baseName.endsWith('_o')) {
    return path.posix.join(dir, `${baseName.slice(0, -2)}_t${ext}`);
  }

  return path.posix.join(dir, `${baseName}_${ext}`);
};

export const cleanupHostingRelativePath = async (
  ftpClient: HostingFtpClient,
  ftpConfig: ReturnType<typeof getHostingFtpConfig>,
  relativePath: string
): Promise<boolean> => {
  const cleaned = normalizeHostedRelativePath(relativePath);
  if (!cleaned || cleaned.includes('..')) return false;

  const remotePath = `${ftpConfig.basePath}/${cleaned}`.replace(/\/+/g, '/');

  try {
    await ftpClient.remove(remotePath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found|no such file|550/i.test(message)) {
      console.warn(`No se pudo borrar archivo remoto ${cleaned}:`, error);
    }
    return false;
  }
};

export const cleanupCommunityPostHostingMedia = async (postData: DocumentData): Promise<void> => {
  const publicBaseUrl = process.env.HOSTING_PUBLIC_BASE_URL || 'https://bot.cdelu.io/images';
  const ftpConfig = getHostingFtpConfig();

  const paths = new Set<string>();
  const addPaths = (value: unknown) => {
    for (const candidate of extractHostedRelativePaths(value, publicBaseUrl)) {
      paths.add(candidate);
    }
  };

  addPaths(postData.imagesV2);
  addPaths(postData.images);
  addPaths(postData.imgMiniatura);
  addPaths(postData.img_miniatura);
  addPaths(postData.thumbnail);
  addPaths(postData.thumbnailUrl);
  addPaths(postData.coverThumbnailUrl);
  addPaths(postData.custom_fields?.image);
  addPaths(postData.custom_fields?.imgMiniatura);
  addPaths(postData.custom_fields?.img_miniatura);
  addPaths(postData.custom_fields?.thumbnail);
  addPaths(postData.custom_fields?.thumbnailUrl);

  for (const imageEntry of Array.isArray(postData.imagesV2) ? postData.imagesV2 : []) {
    if (!imageEntry || typeof imageEntry !== 'object') continue;
    const entry = imageEntry as Record<string, unknown>;
    if (typeof entry.path === 'string') paths.add(normalizeHostedRelativePath(entry.path));
    if (typeof entry.thumbPath === 'string') paths.add(normalizeHostedRelativePath(entry.thumbPath));
  }

  const derivedThumbs = Array.from(paths)
    .map((relativePath) => deriveHostingThumbRelativePath(relativePath))
    .filter((relativePath): relativePath is string => Boolean(relativePath));
  for (const relativePath of derivedThumbs) {
    paths.add(relativePath);
  }

  const { Client } = await loadFtpClient();
  const ftpClient = new Client(30_000);
  ftpClient.ftp.verbose = false;

  try {
    await ftpClient.access({
      host: ftpConfig.host,
      user: ftpConfig.user,
      password: ftpConfig.password,
      port: ftpConfig.port,
      secure: false
    });

    for (const relativePath of paths) {
      await cleanupHostingRelativePath(ftpClient, ftpConfig, relativePath);
    }
  } finally {
    ftpClient.close();
  }
};
