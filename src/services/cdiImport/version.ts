/**
 * The parser's version, stored on every material it produces.
 *
 * Assume the first parser gets a good share of real exports right and not all
 * of them. Recording which version read a material is what makes it possible to
 * find the ones worth re-reading when the parser improves — which is only
 * possible at all because the original HTML is kept (phase 3).
 *
 * Bump the minor when parsing behaviour changes in a way that could produce a
 * different result for the same input.
 */
export const PARSER_VERSION = '1.0.0';
