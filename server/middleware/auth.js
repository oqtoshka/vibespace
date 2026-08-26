// Compatibility shim: the auth middleware moved to server/modules/auth with
// the upstream module refactor. Legacy routes under server/routes still import
// it from here until they are ported into modules.
export * from '../modules/auth/auth.middleware.js';
