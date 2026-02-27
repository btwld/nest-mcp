const ALLOWED_PROTOCOLS = ['http:', 'https:'];

export class URLSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'URLSecurityError';
  }
}

export function validateUrlProtocol(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new URLSecurityError('URL must be a non-empty string');
  }

  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new URLSecurityError('URL cannot be empty or whitespace only');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new URLSecurityError(`Invalid URL format: ${trimmedUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.includes(parsedUrl.protocol)) {
    throw new URLSecurityError(
      `URL protocol "${parsedUrl.protocol}" is not allowed. Only HTTP and HTTPS protocols are permitted.`,
    );
  }

  return trimmedUrl;
}

export function validateUrlsProtocol(urls: string[]): string[] {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new URLSecurityError('URLs must be a non-empty array');
  }

  const validatedUrls: string[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  for (const url of urls) {
    try {
      validatedUrls.push(validateUrlProtocol(url));
    } catch (e) {
      errors.push({ url, error: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  if (errors.length > 0) {
    const details = errors.map((e, i) => `  ${i + 1}. ${e.url}: ${e.error}`).join('\n');
    throw new URLSecurityError(`${errors.length} URL(s) failed validation:\n${details}`);
  }

  return validatedUrls;
}
