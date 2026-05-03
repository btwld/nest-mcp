---
'@nest-mcp/common': minor
---

feat(common): support RFC 6570 form-style query expansion in resource URI templates

`matchUriTemplate` now recognizes the `{?name,email}` query-expansion syntax.
For a template like `users/{id}{?expand,fields}` matched against a URI like
`users/42?expand=true&fields=name`, the returned `params` map contains both
the path params (`id`) and the declared query params (`expand`, `fields`),
merged. Query params not declared in the template are ignored. Path matching
is unchanged for templates that don't use `{?...}`.
