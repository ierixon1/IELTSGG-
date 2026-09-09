import { describe, it } from 'node:test';
import { expect } from './harness';

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'local';

const { sanitizeHtmlServer, validateHtmlFileBuffer, deepSanitizeHtml } = await import(
  '../src/routes/adminRoutes'
);
const { namespaceCdiId } = await import('../src/utils/cdiIds');

/**
 * The HTML ingestion boundary.
 *
 * Two jobs are tested separately and must not be confused. The first is
 * security: nothing imported may execute, navigate, exfiltrate or impersonate
 * part of the app. The second is the *vocabulary baseline* — which CDI
 * constructs survive sanitisation today. That baseline is deliberately
 * recorded rather than asserted as desirable: the importer in Phase 6 is what
 * recovers interactivity, by parsing these constructs into the question model
 * rather than by letting them through as live markup.
 */

describe('HTML file validation', () => {
  it('accepts a plain HTML document', () => {
    expect(validateHtmlFileBuffer(Buffer.from('<p>hello</p>')).valid).toBe(true);
  });

  it('rejects an empty file', () => {
    const result = validateHtmlFileBuffer(Buffer.from(''));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('rejects a file with no recognisable HTML structure', () => {
    expect(validateHtmlFileBuffer(Buffer.from('just some prose')).valid).toBe(false);
  });

  it('rejects binaries wearing an .html extension', () => {
    // PDF, ZIP/DOCX, PNG and ELF magic.
    expect(validateHtmlFileBuffer(Buffer.from('%PDF-1.4 <p>x</p>')).valid).toBe(false);
    expect(validateHtmlFileBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x3c, 0x70, 0x3e])).valid).toBe(false);
    expect(validateHtmlFileBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).valid).toBe(false);
    expect(validateHtmlFileBuffer(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x3c, 0x70, 0x3e])).valid).toBe(false);
  });

  it('rejects NUL bytes and non-UTF-8 encodings', () => {
    expect(validateHtmlFileBuffer(Buffer.from('<p>x</p>', 'utf16le')).valid).toBe(false);
    expect(validateHtmlFileBuffer(Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe])).valid).toBe(false);
  });

  it('tolerates tabs and newlines, which are not binary', () => {
    const body = `<p>${String.fromCharCode(9)}ok${String.fromCharCode(13, 10)}</p>`;
    expect(validateHtmlFileBuffer(Buffer.from(body)).valid).toBe(true);
  });

  it('enforces the 5MB ceiling', () => {
    const tooBig = Buffer.from(`<p>${'a'.repeat(5 * 1024 * 1024)}</p>`);
    const result = validateHtmlFileBuffer(tooBig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('5MB');
  });
});

describe('sanitizer: nothing imported may execute', () => {
  it('drops script, iframe, object and embed', () => {
    const out = sanitizeHtmlServer(
      '<script>alert(1)</script><iframe src="https://evil.example"></iframe>' +
        '<object data="x.swf"></object><embed src="y">',
    );
    expect(out).not.toContain('script');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('object');
    expect(out).not.toContain('embed');
  });

  it('drops every inline event handler', () => {
    for (const handler of ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onanimationend']) {
      const out = sanitizeHtmlServer(`<p ${handler}="alert(1)">x</p>`);
      expect(out).toBe('<p>x</p>');
    }
  });

  it('drops javascript: and vbscript: hrefs', () => {
    expect(sanitizeHtmlServer('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    expect(sanitizeHtmlServer('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript');
    expect(sanitizeHtmlServer('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toContain('aVaScR');
  });

  it('drops a data: document link while keeping data: images', () => {
    // `data` was in the global scheme list, so <a href="data:text/html"> passed.
    expect(sanitizeHtmlServer('<a href="data:text/html;base64,PHA+">x</a>')).not.toContain('data:');
    expect(sanitizeHtmlServer('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain('data:image/png');
  });

  it('drops svg, math and template, which carry mutation vectors', () => {
    expect(sanitizeHtmlServer('<svg><foreignObject><p>hi</p></foreignObject></svg>')).not.toContain('svg');
    expect(sanitizeHtmlServer('<template><input name="q1"></template>')).not.toContain('input');
    expect(sanitizeHtmlServer('<math><mglyph></mglyph></math>')).not.toContain('math');
  });

  it('drops base and meta, which redirect the page', () => {
    expect(sanitizeHtmlServer('<base href="http://evil.example/">')).toBe('');
    expect(sanitizeHtmlServer('<meta http-equiv="refresh" content="0;url=http://evil.example">')).toBe('');
  });

  it('neutralises a noscript mutation payload by escaping it, not by reviving it', () => {
    const out = sanitizeHtmlServer(
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    );
    // The payload survives only as entity-escaped text inside an attribute
    // value, which no parser will ever treat as markup. What must not happen is
    // it coming back as a live element.
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<noscript');
  });
});

describe('sanitizer: CSS cannot be used to attack or escape', () => {
  it('drops expression(), url() and @import', () => {
    expect(sanitizeHtmlServer('<p style="width:expression(alert(1))">x</p>')).toBe('<p>x</p>');
    expect(sanitizeHtmlServer('<p style="background-color:url(http://evil.example)">x</p>')).toBe('<p>x</p>');
    expect(sanitizeHtmlServer('<p style="@import url(evil.css)">x</p>')).toBe('<p>x</p>');
  });

  it('keeps a legitimate declaration but drops a smuggled one beside it', () => {
    const out = sanitizeHtmlServer(
      '<p style="border:1px solid red;background-image:url(http://evil.example/x)">x</p>',
    );
    expect(out).toContain('border:1px solid red');
    expect(out).not.toContain('background-image');
  });

  it('drops position and z-index, which would let content escape the viewer', () => {
    const out = sanitizeHtmlServer('<td style="border-top:1px red ; position:fixed ; z-index:9999">x</td>');
    expect(out).not.toContain('position');
    expect(out).not.toContain('z-index');
  });

  it('drops breakout utility classes but keeps cdi-* and safe typography', () => {
    const out = sanitizeHtmlServer('<div class="cdi-passage fixed inset-0 z-50 text-center font-serif">x</div>');
    expect(out).toContain('cdi-passage');
    expect(out).toContain('text-center');
    expect(out).toContain('font-serif');
    expect(out).not.toContain('fixed');
    expect(out).not.toContain('inset-0');
    expect(out).not.toContain('z-50');
  });

  it('drops a <style> block entirely', () => {
    expect(sanitizeHtmlServer('<style>.q{position:fixed}</style><p>x</p>')).toBe('<p>x</p>');
  });
});

describe('sanitizer: imported markup cannot impersonate the app', () => {
  it('namespaces ids so they cannot shadow the app DOM', () => {
    // `root` is the React mount point; `btn-recalculate-plan` is a real control.
    // An unnamespaced duplicate wins document.getElementById and window named
    // access.
    expect(sanitizeHtmlServer('<div id="root">hijack</div>')).toBe('<div id="cdi-id-root">hijack</div>');
    expect(sanitizeHtmlServer('<div id="btn-recalculate-plan">x</div>')).toContain('id="cdi-id-btn-recalculate-plan"');
    expect(sanitizeHtmlServer('<div id="select-active-test">x</div>')).not.toContain('"select-active-test"');
  });

  it('drops an id that namespaces to nothing', () => {
    expect(sanitizeHtmlServer('<div id="   ">x</div>')).toBe('<div>x</div>');
    expect(namespaceCdiId('---')).toBe('');
  });

  it('rewrites same-document anchors to match, and leaves them in the tab', () => {
    const out = sanitizeHtmlServer('<a href="#section2">Go</a><h2 id="section2">S2</h2>');
    expect(out).toContain('href="#cdi-id-section2"');
    expect(out).toContain('id="cdi-id-section2"');
    // A CDI page's own internal link is not outbound.
    expect(out).not.toContain('target="_blank"');
  });

  it('forces noopener on genuinely outbound links and ignores an attempted override', () => {
    const out = sanitizeHtmlServer('<a href="https://ok.example" target="_self" rel="">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toContain('_self');
  });

  it('blocks remote images, which would leak IP and user agent', () => {
    const out = sanitizeHtmlServer('<img src="https://evil.example/pixel.png">');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('External image blocked');
  });
});

describe('deepSanitizeHtml', () => {
  it('sanitises htmlContent and passageHtml wherever they are nested', () => {
    const out = deepSanitizeHtml({
      content: {
        passage: { htmlContent: '<p onclick="alert(1)">x</p><script>y</script>' },
        nested: [{ passageHtml: '<a href="javascript:alert(1)">z</a>' }],
      },
    });
    expect(out.content.passage.htmlContent).toBe('<p>x</p>');
    expect(out.content.nested[0].passageHtml).not.toContain('javascript');
  });

  it('leaves non-HTML fields untouched', () => {
    const out = deepSanitizeHtml({ title: 'A < B', content: { text: 'plain < text' } });
    expect(out.title).toBe('A < B');
    expect(out.content.text).toBe('plain < text');
  });
});

describe('CDI vocabulary baseline', () => {
  /**
   * A single fixture carrying the constructs a real CDI export uses. These
   * assertions record today's behaviour so Phase 6 changes it deliberately: the
   * controls are stripped, which is why an imported page is inert, and why the
   * importer has to parse them into the question model instead.
   */
  const CDI_PAGE = [
    '<div class="cdi-wrap" data-test-id="L-13">',
    '<audio controls><source src="audio/s1.mp3" type="audio/mpeg"></audio>',
    '<img src="images/map1.png" alt="campus map">',
    '<h2>Section 1 &mdash; Questions 1&ndash;10</h2>',
    '<p class="instruction">Write <strong>NO MORE THAN TWO WORDS</strong>.</p>',
    '<form id="answers">',
    '<label for="q1">1 Email address:</label>',
    '<input id="q1" name="q1" type="text" data-answer="helen123">',
    '<table><tr><th>Preference</th><th>Answer</th></tr>',
    '<tr><td>Accommodation</td><td><input name="q6" data-answer="lodge"></td></tr></table>',
    '<fieldset><legend>11. How much to tip?</legend>',
    '<label><input type="radio" name="q11" value="A" data-answer="true"> as they feel right</label>',
    '<label><input type="radio" name="q11" value="B"> no tip at all</label></fieldset>',
    '<label><input type="checkbox" name="q21" value="A"> Option A</label>',
    '<select name="q31"><option value="iv">iv</option></select>',
    '<textarea name="notes"></textarea>',
    '<button type="submit">Submit</button>',
    '</form>',
    '<div hidden id="answer-key" data-keys="q1:helen123"></div>',
    '</div>',
  ].join('');

  const sanitized = sanitizeHtmlServer(CDI_PAGE);

  it('keeps document structure and tables', () => {
    expect(sanitized).toContain('<h2>');
    expect(sanitized).toContain('<table>');
    expect(sanitized).toContain('<th>Preference</th>');
    expect(sanitized).toContain('NO MORE THAN TWO WORDS');
    expect(sanitized).toContain('cdi-wrap');
    // Entities resolve to real characters rather than surviving as markup.
    expect(sanitized).toContain('Questions 1');
  });

  it('strips every interactive control — an imported page collects no answers', () => {
    for (const tag of ['<input', '<select', '<option', '<textarea', '<button', '<form', '<label', '<fieldset', '<legend']) {
      expect(sanitized).not.toContain(tag);
    }
  });

  it('strips embedded media, so audio and images need an asset reference instead', () => {
    expect(sanitized).not.toContain('<audio');
    expect(sanitized).not.toContain('<source');
    expect(sanitized).not.toContain('<img');
    expect(sanitized).toContain('External image blocked');
  });

  it('strips data-* attributes, including any embedded answer key', () => {
    expect(sanitized).not.toContain('data-answer');
    expect(sanitized).not.toContain('data-keys');
    expect(sanitized).not.toContain('data-test-id');
    expect(sanitized).not.toContain('helen123');
    expect(sanitized).not.toContain('lodge');
  });

  it('loses the option identity that marking depends on', () => {
    // The three tip options collapse to undifferentiated text: no control, no
    // value, no letter. Recovering them is the importer's job, not the
    // sanitiser's.
    expect(sanitized).toContain('as they feel right');
    expect(sanitized).toContain('no tip at all');
    expect(sanitized).not.toContain('value="A"');
    expect(sanitized).not.toContain('name="q11"');
  });

  it('shrinks the page substantially, which is the measure of what is lost', () => {
    expect(sanitized.length).toBeLessThan(CDI_PAGE.length);
  });
});
