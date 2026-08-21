// Sprint B3 — provider-as-data registry.
// Schema inspired by NangoHQ/nango's `providers.yaml` concept (Elastic License v2);
// all data values here are written fresh from public provider documentation,
// not copied from Nango's YAML.

/** How the credential is attached to a verification request. */
export type VerifyAuth = 'bearer' | 'x-api-key' | 'none'

/** Fields common to every provider definition. */
export interface ProviderBase {
  /** Unique provider slug (matches the YAML key). */
  id:         string
  /** Human-readable display name. */
  label:      string
  /** URL TachiDesk hits to confirm a saved key/token still works. */
  verifyUrl:  string
  /** How the credential is attached to the verify request. */
  verifyAuth: VerifyAuth
}

/** OAuth 2.0 Authorization Code + PKCE flow (browser redirect). */
export interface OAuthPkceProvider extends ProviderBase {
  kind:        'oauth_pkce'
  /** Authorization endpoint — the URL the browser opens. */
  authBaseUrl: string
  /** Token endpoint — server-side code exchange. */
  tokenUrl:    string
  /** Registered application client ID (omitted for providers that use implicit flows). */
  clientId?:   string
  /** Space-separated OAuth scopes requested. */
  scope:       string
}

/** OAuth 2.0 Device Authorization Grant flow. */
export interface OAuthDeviceProvider extends ProviderBase {
  kind:        'oauth_device'
  /** Device authorization endpoint. */
  authBaseUrl: string
  /** Token endpoint — polled until user completes auth on another device. */
  tokenUrl:    string
  /** Registered application client ID (required for device flow). */
  clientId:    string
  /** Space-separated OAuth scopes requested. */
  scope:       string
}

/** Static API key — user pastes a key from the provider's dashboard. */
export interface ApiKeyProvider extends ProviderBase {
  kind: 'api_key'
}

/** Local process — no authentication required (e.g. Ollama). */
export interface LocalProvider extends ProviderBase {
  kind: 'local'
}

/** Union of all provider definition shapes. */
export type ProviderDef =
  | OAuthPkceProvider
  | OAuthDeviceProvider
  | ApiKeyProvider
  | LocalProvider
