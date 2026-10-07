import { SetMetadata } from '@nestjs/common';

import type { PermissionCode } from './permissions';

/** Metadata key marking a route as reachable without a session. */
export const PUBLIC_KEY = 'auth:public';

/** Metadata key holding the permission code a route requires. */
export const PERMISSION_KEY = 'auth:permission';

/**
 * Marks a handler (or whole controller) as public: the session guard skips it
 * entirely — no cookie is read and nothing is attached to the request.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Declares the single permission code a route needs. Evaluated against the
 * caller's current role after the session has been validated; when the code is
 * absent the guard only demands a valid session.
 */
export const RequirePermission = (code: PermissionCode) =>
  SetMetadata(PERMISSION_KEY, code);
