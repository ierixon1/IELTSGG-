/**
 * Whether the development impersonation switch is on (M11).
 *
 * `EXPLICIT_DEV_AUTH=true` lets a request act as any existing account through the
 * `x-user-id` header, and hands out password-reset tokens in the response. It was
 * refused only when `NODE_ENV` was `production`, so a hosted server that simply
 * forgot to set `NODE_ENV` — a staging box, a misconfigured container — honoured
 * it. Now it takes effect only when `NODE_ENV` says, explicitly, `development` or
 * `test`; the startup check refuses the switch in every other case.
 */
export const DEV_AUTH_ENVIRONMENTS = new Set(['development', 'test']);

export const explicitDevAuthEnabled = (): boolean =>
  DEV_AUTH_ENVIRONMENTS.has(process.env.NODE_ENV ?? '') && process.env.EXPLICIT_DEV_AUTH === 'true';
