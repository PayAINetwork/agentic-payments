import crypto from 'node:crypto';
import { PayAIApiError } from './errors.js';
import type {
  AgentPaymentsConfig,
  EndpointConfig,
  ManagedApiConfig,
  ManagedApiKey,
  ManagedApiKeyCredentials,
  Protocol,
} from './types.js';

const DEFAULT_API_BASE_URL = 'https://merchant.payai.network';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface PayAIApiClientOptions {
  apiKey: ManagedApiKey;
  baseUrl?: string;
  /**
   * Public URL where the merchant's server is reachable. Forwarded to the
   * portal on init() so the onboarding UI can probe the endpoint. When unset,
   * `buildInitPayload` falls back to PAYAI_APP_URL and a handful of well-known
   * platform env vars (see resolveAppUrl).
   */
  appUrl?: string;
  fetchImpl?: typeof fetch;
  onConfigChanged?: (config: ManagedApiConfig) => void | Promise<void>;
  onLiveModeChanged?: (live: boolean) => void | Promise<void>;
}

export interface InitPayload {
  sdkVersion: string | null;
  packageName: string | null;
  environment: string | null;
  appUrl: string | null;
  endpoints: InitEndpointPayload[];
}

export interface InitEndpointPayload {
  method: string;
  route: string;
  price: string | null;
  description: string | null;
  assets: string[];
  networks: string[];
  protocols: Protocol[];
}

interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

interface LiveModeChangedPayload {
  live: boolean;
}

export class PayAIApiClient {
  private readonly apiKey: ManagedApiKey;
  private readonly baseUrl: string;
  private readonly appUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly onConfigChanged?: PayAIApiClientOptions['onConfigChanged'];
  private readonly onLiveModeChanged?: PayAIApiClientOptions['onLiveModeChanged'];
  private abortController: AbortController | null = null;
  private currentConfig: ManagedApiConfig | null = null;
  private live = false;

  constructor(options: PayAIApiClientOptions);
  constructor(apiKey: ManagedApiKey, baseUrl?: string);
  constructor(optionsOrApiKey: PayAIApiClientOptions | ManagedApiKey, baseUrl?: string) {
    const options =
      typeof optionsOrApiKey === 'string' || isManagedApiKeyCredentials(optionsOrApiKey)
        ? { apiKey: optionsOrApiKey, baseUrl }
        : optionsOrApiKey;

    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.PAYAI_API_URL ?? DEFAULT_API_BASE_URL
    );
    this.appUrl = resolveAppUrl(options.appUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onConfigChanged = options.onConfigChanged;
    this.onLiveModeChanged = options.onLiveModeChanged;
  }

  get config(): ManagedApiConfig | null {
    return this.currentConfig;
  }

  get liveMode(): boolean {
    return this.live;
  }

  async init(config: AgentPaymentsConfig): Promise<ManagedApiConfig> {
    const apiConfig = await this.request<ManagedApiConfig>('/api/v1/sdk/init', {
      method: 'POST',
      body: JSON.stringify(buildInitPayload(config, this.appUrl)),
    });

    await this.applyConfig(apiConfig);
    return apiConfig;
  }

  async fetchConfig(): Promise<ManagedApiConfig> {
    const apiConfig = await this.request<ManagedApiConfig>('/api/v1/sdk/config', {
      method: 'GET',
    });

    await this.applyConfig(apiConfig);
    return apiConfig;
  }

  startEvents(): void {
    if (this.abortController) return;

    this.abortController = new AbortController();
    void this.runEventLoop(this.abortController.signal);
  }

  stopEvents(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async registerEndpoints(configOrEndpoints: AgentPaymentsConfig | Record<string, EndpointConfig>) {
    const config =
      'endpoints' in configOrEndpoints ? configOrEndpoints : { endpoints: configOrEndpoints };
    await this.init(config as AgentPaymentsConfig);
  }

  private async runEventLoop(signal: AbortSignal): Promise<void> {
    let reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;

    while (!signal.aborted) {
      try {
        await this.fetchConfig();
        await this.consumeEventStream(signal);
        reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
      } catch (error) {
        if (signal.aborted) return;
        if (isClientApiError(error)) throw error;

        await delay(reconnectDelayMs, signal).catch(() => undefined);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  private async consumeEventStream(signal: AbortSignal): Promise<void> {
    const response = await this.fetchWithAuth('/api/v1/sdk/events', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
    });

    if (!response.ok) throw await toApiError(response);
    if (!response.body) throw new PayAIApiError('SDK event stream response did not include a body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal.aborted) {
        const result = await reader.read();
        if (result.done) return;

        buffer += decoder.decode(result.value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.remainder;

        for (const event of parsed.events) await this.handleSseEvent(event);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleSseEvent(event: SseEvent): Promise<void> {
    if (event.event === 'config') {
      await this.applyConfig(parseJson<ManagedApiConfig>(event.data, 'config event'));
      return;
    }

    if (event.event === 'live_mode_changed') {
      const payload = parseJson<LiveModeChangedPayload>(event.data, 'live mode event');
      const config = await this.fetchConfig();
      await this.onLiveModeChanged?.(config.live ?? payload.live);
    }
  }

  private async applyConfig(config: ManagedApiConfig): Promise<void> {
    this.currentConfig = config;
    this.live = config.live;
    await this.onConfigChanged?.(config);
  }

  private async request<TResponse>(path: string, init: RequestInit): Promise<TResponse> {
    const response = await retryRequest(() => this.fetchWithAuth(path, init));
    return parseJson<TResponse>(await response.text(), path);
  }

  private async fetchWithAuth(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${createAuthToken(this.apiKey)}`);

    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
  }
}

async function retryRequest(request: () => Promise<Response>): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await request();
      if (response.ok) return response;
      if (response.status >= 400 && response.status < 500) throw await toApiError(response);
      lastError = await toApiError(response);
    } catch (error) {
      if (isClientApiError(error)) throw error;
      lastError = error;
    }

    if (attempt < DEFAULT_RETRY_ATTEMPTS) await delay(250 * attempt);
  }

  if (lastError instanceof Error) throw lastError;
  throw new PayAIApiError('PayAI API request failed');
}

function createAuthToken(apiKey: ManagedApiKey): string {
  if (typeof apiKey === 'string') return apiKey;
  return generateJwt(apiKey);
}

function generateJwt(credentials: ManagedApiKeyCredentials): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: credentials.keyId };
  const payload = {
    sub: credentials.keyId,
    iss: 'payai',
    iat: now,
    exp: now + 120,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign(null, Buffer.from(message), parsePrivateKey(credentials.secret));

  return `${message}.${base64UrlEncode(signature)}`;
}

function parsePrivateKey(secret: string): crypto.KeyObject {
  if (!secret.startsWith('payai_sk_')) {
    throw new PayAIApiError('Invalid PayAI API key secret format');
  }

  return crypto.createPrivateKey({
    key: Buffer.from(secret.slice('payai_sk_'.length), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

function buildInitPayload(config: AgentPaymentsConfig, appUrl: string | null): InitPayload {
  return {
    sdkVersion: process.env.npm_package_version ?? null,
    packageName: process.env.npm_package_name ?? '@payai/agentic-payments',
    environment: process.env.NODE_ENV ?? null,
    appUrl,
    endpoints: Object.entries(config.endpoints).flatMap(([key, endpoint]) =>
      buildEndpointPayload(key, endpoint)
    ),
  };
}

/**
 * Resolve the public URL of the merchant's server, in priority order:
 *
 *   1. Explicit `config.appUrl` / `PayAIApiClientOptions.appUrl`
 *   2. `PAYAI_APP_URL` env var (manual override, useful for self-hosted deploys)
 *   3. Auto-detection from common hosting providers
 *
 * Auto-detection covers the platforms most likely to run an Express app:
 *   - Vercel: `VERCEL_PROJECT_PRODUCTION_URL` (production) → `VERCEL_URL` (preview)
 *   - Fly.io: `FLY_APP_NAME` → `https://<app>.fly.dev`
 *   - Railway: `RAILWAY_PUBLIC_DOMAIN`
 *   - Render: `RENDER_EXTERNAL_URL`
 *
 * Returns `null` when no URL can be determined; the dashboard then prompts
 * the user to fill it in via the editable Server URL field on /onboarding/endpoints.
 */
function resolveAppUrl(explicit?: string): string | null {
  const candidate = firstNonEmpty([
    explicit,
    process.env.PAYAI_APP_URL,
    detectHostedAppUrl(),
  ]);
  return candidate ? stripTrailingSlash(candidate) : null;
}

function detectHostedAppUrl(): string | null {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return ensureScheme(vercel);

  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;

  return null;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function ensureScheme(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildEndpointPayload(key: string, endpoint: EndpointConfig): InitEndpointPayload[] {
  const match = key.trim().match(/^(\S+)\s+(.+)$/);
  if (!match) return [];

  const [, method, route] = match;

  return [
    {
      method: method.toUpperCase(),
      route: route.startsWith('/') ? route : `/${route}`,
      price: serializePrice(endpoint.price),
      description: endpoint.description ?? null,
      assets: serializeStringValues(endpoint.assets),
      networks: endpoint.networks ?? [],
      protocols: endpoint.protocols ?? [],
    },
  ];
}

function serializePrice(price: EndpointConfig['price']): string | null {
  if (typeof price === 'string') return price;
  if (isStringRecord(price)) return JSON.stringify(price);
  return null;
}

function serializeStringValues(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];

  return values.flatMap(value => {
    if (typeof value === 'string') return [value];
    if (isRecord(value) && typeof value.name === 'string') return [value.name];
    return [];
  });
}

async function toApiError(response: Response): Promise<PayAIApiError> {
  const text = await response.text().catch(() => '');
  const detail = text ? `: ${text}` : '';
  return new PayAIApiError(`PayAI API returned ${response.status}${detail}`, response.status);
}

function isClientApiError(error: unknown): error is PayAIApiError {
  return (
    error instanceof PayAIApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

function parseJson<TValue>(text: string, label: string): TValue {
  try {
    return JSON.parse(text) as TValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new PayAIApiError(`Failed to parse PayAI ${label} response: ${message}`);
  }
}

export function parseSseBuffer(buffer: string): { events: SseEvent[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const remainder = chunks.pop() ?? '';
  return { events: chunks.flatMap(parseSseChunk), remainder };
}

function parseSseChunk(chunk: string): SseEvent[] {
  const event: SseEvent = { id: null, event: 'message', data: '' };

  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1).trimStart();

    if (field === 'id') event.id = value;
    else if (field === 'event') event.event = value;
    else if (field === 'data') event.data = event.data ? `${event.data}\n${value}` : value;
  }

  return event.data ? [event] : [];
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) return;

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new PayAIApiError('PayAI API event stream stopped'));
      },
      { once: true }
    );
  });
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function base64UrlEncode(value: string | Buffer): string {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  return buffer.toString('base64url');
}

function isManagedApiKeyCredentials(value: unknown): value is ManagedApiKeyCredentials {
  return isRecord(value) && typeof value.keyId === 'string' && typeof value.secret === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}
