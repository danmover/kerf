// Who decides who may use this copy of Kerf: the owner's public key, and the
// sign-in server (access-server/) that hands out tickets signed with it.
// Neither is a secret. The private key is only on the owner's PC and, as a
// Worker secret, on the owner's Cloudflare account.

/** The owner key's public half (SPKI DER, base64). Tickets and owner requests must be signed by its private half. */
export const OWNER_PUBLIC_KEY = "MCowBQYDK2VwAyEAEwAIKeEqYaWDynCdwA7npUc7qlv1b9GndwDIUOR7smM=";

/** The sign-in server: the Worker in access-server/ on the owner's Cloudflare account. */
export const ACCESS_SERVER = "https://kerf-access.8ball-worker.workers.dev";

/**
 * A local build can point at a test server and trust its throwaway key
 * (scripts/build-desktop.mjs with KERF_ACCESS_SERVER / KERF_ACCESS_TEST_PUBLIC_KEY).
 * These are fixed when the app is built, not read at run time, so nobody can
 * point an installed Kerf at a server of their own.
 */
declare const __KERF_ACCESS_SERVER__: string;
declare const __KERF_ACCESS_TEST_KEY__: string;

export function accessConfig() {
  const server = (typeof __KERF_ACCESS_SERVER__ === "string" && __KERF_ACCESS_SERVER__) || ACCESS_SERVER;
  const key = (typeof __KERF_ACCESS_TEST_KEY__ === "string" && __KERF_ACCESS_TEST_KEY__) || OWNER_PUBLIC_KEY;
  return { server: server.replace(/\/+$/, ""), publicKey: key, test: key !== OWNER_PUBLIC_KEY };
}
