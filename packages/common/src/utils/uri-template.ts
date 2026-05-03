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
  // Pull out the form-style query expansions first; the remainder is the path.
  const queryParamNames: string[] = [];
  const pathOnly = template.replace(QUERY_PARAM_RE, (_match, names: string) => {
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (name) queryParamNames.push(name);
    }
    return '';
  });

  const pathParamNames: string[] = [];
  const regexStr = pathOnly.replace(PATH_PARAM_RE, (_match, name: string) => {
    pathParamNames.push(name);
    return '([^/?]+)';
  });

  return {
    pathRegex: new RegExp(`^${regexStr}$`),
    pathParamNames,
    queryParamNames,
  };
}

function splitUri(uri: string): { path: string; query: string } {
  const idx = uri.indexOf('?');
  return idx === -1
    ? { path: uri, query: '' }
    : { path: uri.slice(0, idx), query: uri.slice(idx + 1) };
}

function parseQueryString(query: string): Record<string, string> {
  if (!query) return {};
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
    if (key) params[key] = value;
  }
  return params;
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
 */
export function matchUriTemplate(template: string, uri: string): UriTemplateMatch | null {
  const { pathRegex, pathParamNames, queryParamNames } = parseTemplate(template);
  const { path, query } = splitUri(uri);

  const pathMatch = path.match(pathRegex);
  if (!pathMatch) return null;

  const params: Record<string, string> = {};

  if (queryParamNames.length > 0) {
    const inputQuery = parseQueryString(query);
    for (const name of queryParamNames) {
      if (inputQuery[name] !== undefined) params[name] = inputQuery[name];
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
