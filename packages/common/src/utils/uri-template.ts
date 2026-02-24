/**
 * Simple RFC 6570 Level 1 URI template parser and matcher.
 * Supports basic {variable} expansion and extraction.
 */

export interface UriTemplateMatch {
  params: Record<string, string>;
}

/**
 * Parse a URI template and return a regex + parameter names for matching.
 */
export function parseUriTemplate(template: string): {
  regex: RegExp;
  paramNames: string[];
} {
  const paramNames: string[] = [];
  const regexStr = template.replace(/\{([^}]+)\}/g, (_match, paramName: string) => {
    paramNames.push(paramName);
    return '([^/]+)';
  });
  return {
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

/**
 * Match a URI against a template and extract parameters.
 */
export function matchUriTemplate(template: string, uri: string): UriTemplateMatch | null {
  const { regex, paramNames } = parseUriTemplate(template);
  const match = uri.match(regex);

  if (!match) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]] = decodeURIComponent(match[i + 1]);
  }

  return { params };
}

/**
 * Expand a URI template with given parameters.
 */
export function expandUriTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, paramName: string) => {
    const value = params[paramName];
    if (value === undefined) {
      throw new Error(`Missing URI template parameter: ${paramName}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Extract parameter names from a URI template.
 */
export function getTemplateParams(template: string): string[] {
  const params: string[] = [];
  template.replace(/\{([^}]+)\}/g, (_match, paramName: string) => {
    params.push(paramName);
    return '';
  });
  return params;
}
