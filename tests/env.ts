/**
 * The environment a test file must declare before it imports anything from src.
 *
 * `src/services/storage` refuses to load without an explicit backend, and a
 * pure unit suite still reaches it through the module graph — a component
 * imports an upload zone, which imports a service, which imports storage. A
 * suite that does not say which backend it means passes only on a machine where
 * the variable happens to already be exported, which is exactly how a green run
 * turns red the moment it moves to CI.
 *
 * Import this first, before any `../src/...` import: ES modules evaluate in
 * import order, so this runs before the graph below it.
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? 'local';

export {};
