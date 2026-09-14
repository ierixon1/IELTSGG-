import type { NextFunction, Request, Response } from 'express';

/**
 * Headers every response carries (M2).
 *
 * In every mode:
 *   - `X-Content-Type-Options: nosniff`: a response is the type it says it is;
 *   - `X-Frame-Options: DENY`: the exam and admin screens cannot be framed
 *     (clickjacking); `frame-ancestors 'none'` says the same in production's CSP;
 *   - `Referrer-Policy: strict-origin-when-cross-origin`: no path or query leaves
 *     for another site;
 *   - `Cross-Origin-Opener-Policy: same-origin`;
 *   - `Permissions-Policy`: the microphone for Speaking on this origin, and no
 *     camera, geolocation, payment or USB.
 *
 * In production, also:
 *   - `Strict-Transport-Security` (production is served over https, `APP_URL`
 *     must be https);
 *   - a Content Security Policy for the built app: its own scripts only, styles
 *     from itself and Google Fonts (index.html loads them), fonts from Google
 *     Fonts, media and images from itself, `data:` and `blob:` (recordings and
 *     inline images the sanitiser allows), requests to itself only, no plugins,
 *     no framing. Development serves Vite's dev client, which injects inline
 *     scripts, so no CSP is sent there.
 *
 * A route may set its own stricter value afterwards: asset downloads replace the
 * CSP with `default-src 'none'; sandbox` (`sendAsset`).
 */

export const PRODUCTION_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(options: { production: boolean }) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
    if (options.production) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('Content-Security-Policy', PRODUCTION_CONTENT_SECURITY_POLICY);
    }
    next();
  };
}
