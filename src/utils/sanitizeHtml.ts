import DOMPurify from 'dompurify';

// Register security hooks once
let hooksInitialized = false;

function getPurifyInstance() {
  if (typeof (DOMPurify as any)?.sanitize === 'function') {
    return DOMPurify;
  }
  if (typeof window !== 'undefined' && typeof (DOMPurify as any) === 'function') {
    return (DOMPurify as any)(window);
  }
  return DOMPurify;
}

function initPurifyHooks() {
  if (hooksInitialized) return;
  const purify = getPurifyInstance();
  if (!purify || typeof purify.addHook !== 'function') return;

  hooksInitialized = true;

  purify.addHook('afterSanitizeAttributes', (node: any) => {
    // 1. Security: Disallow arbitrary external img src (prevents tracking pixels & IP/UA leakage)
    if (node.tagName === 'IMG') {
      const src = (node.getAttribute('src') || '').trim();
      const isLocalUpload = src.startsWith('/api/uploads/');
      const isSafeBase64 = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src);

      if (!isLocalUpload && !isSafeBase64) {
        node.removeAttribute('src');
        node.setAttribute('data-blocked-external-img', 'true');
        node.setAttribute('alt', '[External image blocked: only internal uploads or base64 are permitted]');
      }
    }

    // 2. Security: Strip breakout Tailwind classes that could escape the viewer container
    if (node.hasAttribute('class')) {
      const cls = node.getAttribute('class') || '';
      const safeClasses = cls
        .split(/\s+/)
        .filter((c) => !/^(fixed|absolute|sticky|z-\d+|inset-|h-screen|w-screen|pointer-events-|opacity-0)/i.test(c))
        .join(' ');
      if (safeClasses) {
        node.setAttribute('class', safeClasses);
      } else {
        node.removeAttribute('class');
      }
    }

    // 3. Security: Strip dangerous CSS style rules (positioning, z-index, url() exfiltration)
    if (node.hasAttribute('style')) {
      const styleVal = node.getAttribute('style') || '';
      if (/(url\s*\(|expression|behavior|position|z-index|fixed|absolute|@import|-moz-|-webkit-|opacity\s*:\s*0)/i.test(styleVal)) {
        const safeStyles = styleVal
          .split(';')
          .map(r => r.trim())
          .filter((rule) => {
            if (!rule) return false;
            if (/(url\s*\(|expression|behavior|position|z-index|fixed|absolute|@import|-moz-|-webkit-|opacity)/i.test(rule)) {
              return false;
            }
            return /^(text-align|vertical-align|font-weight|font-style|text-decoration|width|max-width|min-width|height|padding|margin|border|border-collapse|border-spacing|color|background-color)\s*:/i.test(rule);
          })
          .join('; ');

        if (safeStyles) {
          node.setAttribute('style', safeStyles);
        } else {
          node.removeAttribute('style');
        }
      }
    }

    // 4. Security: Force noopener, noreferrer, nofollow on all hyperlinks
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

/**
 * Sanitizes HTML content on the client-side using DOMPurify.
 * Strips script tags, inline event listeners (onclick, etc.), and dangerous protocols.
 * Allows rich text tags, formatting, tables, images, and safe presentation styling.
 */
export function sanitizeClientHtml(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== 'string') return '';

  initPurifyHooks();

  const purify = getPurifyInstance();
  if (!purify || typeof purify.sanitize !== 'function') {
    return rawHtml;
  }

  return purify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
      'span', 'div', 'blockquote', 'q', 'pre', 'code',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
      'img', 'a', 'figure', 'figcaption',
      'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
      'details', 'summary'
    ],
    ALLOWED_ATTR: [
      'class', 'id', 'style', 'title', 'lang', 'dir',
      'src', 'alt', 'width', 'height', 'loading',
      'href', 'target', 'rel',
      'colspan', 'rowspan', 'headers', 'scope'
    ],
    ALLOWED_URI_REGEXP: /^(?:(?:\/api\/uploads\/|https?:\/\/|mailto:)|data:image\/(?:png|jpeg|jpg|webp|gif);base64,)/i,
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit'],
  });
}
