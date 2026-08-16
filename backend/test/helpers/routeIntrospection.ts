import type { Router } from "express";

type ExpressRouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

export type ScopedRoute = {
  method: string;
  /** The raw Express path pattern (e.g. `/:workspaceId/members/:userId`),
   * relative to `mountPath`. */
  path: string;
  fullPath: string;
};
/** @deprecated kept as an alias — existing tests import this name. */
export type WorkspaceScopedRoute = ScopedRoute;

/**
 * Walks a router's own route stack — no recursion into nested routers
 * needed, since every route in a given resource's family lives on one
 * `Router` instance by convention (workspace/member/invite routes on
 * `workspaceRouter`, channel/message routes on `channelRouter`) —
 * docs/security-model.md §7.2's `collectWorkspaceScopedRoutes`, adapted to
 * Express 4's actual internals and generalized to any `:paramName`. Returns
 * every route whose path pattern contains `:paramName`, so a newly added
 * endpoint is covered by the relevant isolation suite automatically.
 */
export function collectScopedRoutes(
  router: Router,
  mountPath: string,
  paramName: string,
): ScopedRoute[] {
  const stack = (router as unknown as { stack: ExpressRouteLayer[] }).stack;
  const routes: ScopedRoute[] = [];
  const marker = `:${paramName}`;

  for (const layer of stack) {
    if (!layer.route || !layer.route.path.includes(marker)) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled) continue;
      routes.push({ method, path: layer.route.path, fullPath: mountPath + layer.route.path });
    }
  }
  return routes;
}

/** @deprecated kept as an alias — existing tests import this name. */
export function collectWorkspaceScopedRoutes(router: Router, mountPath: string): ScopedRoute[] {
  return collectScopedRoutes(router, mountPath, "workspaceId");
}

/** Substitutes `:paramName` segments in an Express path pattern with
 * concrete values, e.g. for building a request URL from a route pattern. */
export function buildPath(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`buildPath: no value provided for :${name} in "${pattern}"`);
    }
    return value;
  });
}
