/**
 * RFC 6570 URI template parser and matcher.
 *
 * Supports:
 * - Level 1 path expansion: `{variable}` → captured into params.
 * - Form-style query expansion: `{?name,email}` → declared query params are
 *   parsed from the URI's query string and merged into params.
 *
 * Path and query params are returned merged in a single `params` map. Query
 * params not declared in the template are ignored. Path params take priority
 * on key collision.
 */

export interface UriTemplateMatch {
  params: Record<string, string>;
}

const PATH_PARAM_RE = /\{(\w+)\}/g;
const QUERY_PARAM_RE = /\{\?([^}]+)\}/g;

interface ParsedTemplate {
  pathRegex: RegExp;
  pathParamNames: string[];
  queryParamNames: string[];
}

function parseTemplate(template: string): ParsedTemplate {
  // Form-style query expansions are pulled out first so they don't pollute
  // the path regex; everything else is treated as the path portion.
  const queryParamNames = [...template.matchAll(QUERY_PARAM_RE)].flatMap((m) =>
    m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const pathOnly = template.replace(QUERY_PARAM_RE, '');
  const pathParamNames = [...pathOnly.matchAll(PATH_PARAM_RE)].map((m) => m[1]);
  const regexStr = pathOnly.replace(PATH_PARAM_RE, '([^/?]+)');

  return {
    pathRegex: new RegExp(`^${regexStr}$`),
    pathParamNames,
    queryParamNames,
  };
}

/**
 * @deprecated Internal — exposed for backwards compatibility. Prefer
 * {@link matchUriTemplate}, which handles both path and query expansions.
 */
export function parseUriTemplate(template: string): {
  regex: RegExp;
  paramNames: string[];
} {
  const { pathRegex, pathParamNames } = parseTemplate(template);
  return { regex: pathRegex, paramNames: pathParamNames };
}

/**
 * Match a URI against a template and extract path + declared query params.
 * Returns `null` when the path portion does not match.
 *
 * Resource URIs may be relative (e.g. `users/42`), so we can't run them
 * through `new URL(...)` — we split on the first `?` and feed the query
 * portion to `URLSearchParams`, which gives us spec-correct
 * `application/x-www-form-urlencoded` decoding (including `+` as space).
 */
export function matchUriTemplate(template: string, uri: string): UriTemplateMatch | null {
  const { pathRegex, pathParamNames, queryParamNames } = parseTemplate(template);
  const queryStart = uri.indexOf('?');
  const path = queryStart === -1 ? uri : uri.slice(0, queryStart);

  const pathMatch = path.match(pathRegex);
  if (!pathMatch) return null;

  const params: Record<string, string> = {};

  if (queryParamNames.length > 0 && queryStart !== -1) {
    const search = new URLSearchParams(uri.slice(queryStart + 1));
    for (const name of queryParamNames) {
      const value = search.get(name);
      if (value !== null) params[name] = value;
    }
  }

  for (let i = 0; i < pathParamNames.length; i++) {
    params[pathParamNames[i]] = decodeURIComponent(pathMatch[i + 1]);
  }

  return { params };
}

/**
 * Expand a URI template with given parameters (path expansions only).
 */
export function expandUriTemplate(template: string, params: Record<string, string>): string {
  // Strip `{?...}` blocks first so they don't trip up the path-param replacer.
  const pathOnly = template.replace(QUERY_PARAM_RE, '');
  return pathOnly.replace(PATH_PARAM_RE, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing URI template parameter: ${name}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Extract every parameter name (path + query) from a URI template, in
 * declaration order.
 */
export function getTemplateParams(template: string): string[] {
  const { pathParamNames, queryParamNames } = parseTemplate(template);
  return [...pathParamNames, ...queryParamNames];
}
