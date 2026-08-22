/**
 * Single source for the server version.
 *
 * Kept as a literal rather than read from package.json: the built server runs
 * from dist/, where package.json sits outside rootDir and would need a runtime
 * file read on every start. Bumped by the release commit alongside package.json.
 */
export const VERSION = "0.8.0";
