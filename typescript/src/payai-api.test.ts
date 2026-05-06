import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayAIApiError } from './errors.js';
import { PayAIApiClient, parseSseBuffer } from './payai-api.js';
import type { AgentPaymentsConfig, ManagedApiConfig, ManagedApiKeyCredentials } from './types.js';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

type MockResponse = Response | (() => Response | Promise<Response>);

type SseHarness = {
  handleSseEvent(event: { id: string | null; event: string; data: string }): Promise<void>;
};

const managedConfig = (overrides: Partial<ManagedApiConfig> = {}): ManagedApiConfig => ({
  live: false,
  facilitatorUrl: 'https://facilitator.payai.network',
  payTo: {
    'eip155:84532': '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  },
  networks: ['eip155:84532'],
  tokens: ['USDC'],
  protocols: ['x402'],
  endpoints: [
    {
      id: 'endpoint_1',
      method: 'GET',
      route: '/weather',
      dashboardPrice: '$0.01',
      dashboardDescription: 'Current weather',
      sourceMetadata: {},
      enabled: true,
      updatedAt: '2026-05-05T00:00:00.000Z',
    },
  ],
  catalogs: [],
  generatedAt: '2026-05-05T00:00:00.000Z',
  ...overrides,
});

const agentConfig: AgentPaymentsConfig = {
  apiKey: createCredentials(),
  endpoints: {
    'GET /weather': {
      price: '$0.01',
      description: 'Current weather',
    },
  },
};

describe('PayAIApiClient', () => {
  it('retries init on 5xx responses', async () => {
    const { fetchImpl, calls } = createFetchMock([
      jsonResponse({ error: 'temporary' }, 500),
      jsonResponse({ error: 'temporary' }, 502),
      jsonResponse(managedConfig()),
    ]);
    const client = new PayAIApiClient({
      apiKey: createCredentials(),
      baseUrl: 'https://merchant.example.test',
      fetchImpl,
    });

    await expect(client.init(agentConfig)).resolves.toMatchObject({ live: false });

    expect(calls).toHaveLength(3);
    expect(calls.map(call => String(call.input))).toEqual([
      'https://merchant.example.test/api/v1/sdk/init',
      'https://merchant.example.test/api/v1/sdk/init',
      'https://merchant.example.test/api/v1/sdk/init',
    ]);
  });

  it('does not retry client errors', async () => {
    const { fetchImpl, calls } = createFetchMock([jsonResponse({ error: 'unauthorized' }, 401)]);
    const client = new PayAIApiClient({
      apiKey: createCredentials(),
      baseUrl: 'https://merchant.example.test',
      fetchImpl,
    });

    await expect(client.init(agentConfig)).rejects.toBeInstanceOf(PayAIApiError);
    expect(calls).toHaveLength(1);
  });

  it('generates a short-lived JWT with the key id in the header', async () => {
    const credentials = createCredentials();
    const { fetchImpl, calls } = createFetchMock([jsonResponse(managedConfig())]);
    const client = new PayAIApiClient({
      apiKey: credentials,
      baseUrl: 'https://merchant.example.test',
      fetchImpl,
    });

    await client.fetchConfig();

    const token = readBearerToken(calls[0].init);
    const [headerSegment, payloadSegment] = token.split('.');
    const header = parseBase64Json(headerSegment);
    const payload = parseBase64Json(payloadSegment);

    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe(credentials.keyId);
    expect(payload.sub).toBe(credentials.keyId);
    expect(payload.iss).toBe('payai');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.iat).toBe('number');
    expect(Number(payload.exp) - Number(payload.iat)).toBe(120);
  });

  it('parses CRLF, multi-event, comments, and partial SSE buffers', () => {
    const parsed = parseSseBuffer(
      ': heartbeat\r\n\r\nid: 1\r\nevent: config\r\ndata: {"live":false}\r\n\r\nevent: live_mode_changed\ndata: {"live":true}\n\nid: partial\n'
    );

    expect(parsed.events).toEqual([
      { id: '1', event: 'config', data: '{"live":false}' },
      { id: null, event: 'live_mode_changed', data: '{"live":true}' },
    ]);
    expect(parsed.remainder).toBe('id: partial\n');
  });

  it('refetches config when live mode changes', async () => {
    const updatedConfig = managedConfig({
      live: true,
      networks: ['eip155:8453'],
      payTo: {
        'eip155:8453': '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    });
    const seenConfigs: ManagedApiConfig[] = [];
    const seenLiveModes: boolean[] = [];
    const { fetchImpl, calls } = createFetchMock([jsonResponse(updatedConfig)]);
    const client = new PayAIApiClient({
      apiKey: createCredentials(),
      baseUrl: 'https://merchant.example.test',
      fetchImpl,
      onConfigChanged: config => {
        seenConfigs.push(config);
      },
      onLiveModeChanged: live => {
        seenLiveModes.push(live);
      },
    });

    await (client as unknown as SseHarness).handleSseEvent({
      id: 'event_1',
      event: 'live_mode_changed',
      data: JSON.stringify({ live: true }),
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe('https://merchant.example.test/api/v1/sdk/config');
    expect(seenConfigs).toEqual([updatedConfig]);
    expect(seenLiveModes).toEqual([true]);
    expect(client.liveMode).toBe(true);
    expect(client.config?.networks).toEqual(['eip155:8453']);
  });
});

function createCredentials(): ManagedApiKeyCredentials {
  const { privateKey } = generateKeyPairSync('ed25519');
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return {
    keyId: 'payai_key_test',
    secret: `payai_sk_${secret}`,
  };
}

function createFetchMock(responses: MockResponse[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const pending = [...responses];
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const response = pending.shift();
    if (!response) {
      throw new Error(`Unexpected fetch call to ${String(input)}`);
    }
    return typeof response === 'function' ? response() : response;
  };

  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function readBearerToken(init: RequestInit | undefined): string {
  const headers = new Headers(init?.headers);
  const authorization = headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new Error('Missing bearer token');
  }
  return authorization.slice('Bearer '.length);
}

function parseBase64Json(segment: string | undefined): Record<string, unknown> {
  if (!segment) {
    throw new Error('Missing JWT segment');
  }

  const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  if (!isRecord(value)) {
    throw new Error('JWT segment was not an object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
