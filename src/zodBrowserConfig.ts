import { z } from 'zod';

/**
 * Zod in the browser, under the production Content Security Policy (M2).
 *
 * Before its first parse Zod probes whether it may compile parsers with
 * `new Function("")`. The CSP allows no eval, so the probe throws; Zod catches that
 * and parses without compiling, but the browser still reports a `script-src eval`
 * violation on every page load. `jitless` skips the probe. Parsing results are the
 * same either way.
 *
 * `main.tsx` imports this module first, before any module that could parse.
 */
z.config({ jitless: true });
