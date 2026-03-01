export interface AuthorizeQueryDto {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method?: string;
  scope?: string;
  state: string;
  resource?: string;
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  created_at: number;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256' | 'plain';
  scope: string;
  resource?: string;
  expires_at: number;
}

export interface TokenPayload {
  sub: string;
  azp?: string;
  client_id?: string;
  iss: string;
  aud?: string;
  type: 'access' | 'refresh';
  scope?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface TokenIntrospectionResponse {
  active: boolean;
  sub?: string;
  client_id?: string;
  scope?: string;
  exp?: number;
  iat?: number;
  token_type?: string;
}
