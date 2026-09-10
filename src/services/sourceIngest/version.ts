/**
 * Versions travel with every chunk.
 *
 * A chunk that was cut by an older chunker, or read by an older extractor, is
 * not wrong — but it is different, and when a book is re-ingested the only way
 * to know which chunks moved is to have recorded what produced them. Bump the
 * extractor version when the text a format yields changes; bump the chunker
 * version when the same text would be cut differently.
 */
export const EXTRACTOR_VERSION = '1.0.0';
export const CHUNKER_VERSION = '1.0.0';
