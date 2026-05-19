import { BUILT_IN_ASSETS, EVM_NETWORKS, SVM_NETWORKS } from "./assets.js";
import type {
  Asset,
  AssetRegistry,
  CustomAssetDef,
  EndpointConfig,
  EndpointMap,
  PayToShorthand,
  PayToValue,
  Price,
  PriceValue,
  RequestContext,
} from "./types.js";

/**
 * Resolved per-network asset info with defaults applied. Returns undefined
 * if the asset has no entry for the network.
 */
export interface ResolvedAssetNetworkInfo {
  address: string;
  decimals: number;
  eip712Name: string;
  eip712Version: string;
}

const DEFAULT_EIP712_VERSION = "2";

/**
 * Look up per-network info for an asset, applying EIP-712 defaults
 * (`eip712Name` → asset.name, `eip712Version` → "2").
 */
export function getAssetNetworkInfo(
  asset: CustomAssetDef,
  network: string,
): ResolvedAssetNetworkInfo | undefined {
  const entry = asset.addresses[network];
  if (!entry) return undefined;
  return {
    address: entry.address,
    decimals: entry.decimals,
    eip712Name: entry.eip712Name ?? asset.name,
    eip712Version: entry.eip712Version ?? DEFAULT_EIP712_VERSION,
  };
}

// --- Route matching ---

/**
 * Match a request method+path against an endpoint map key.
 * Keys are "METHOD /path" format. Supports:
 * - Exact: "GET /weather"
 * - Wildcard method: "* /health"
 * - Glob path: "GET /api/*"
 * - Param segments: "GET /marketplace/:seller"
 */
export function matchEndpoint(
  method: string,
  path: string,
  endpoints: EndpointMap,
): EndpointConfig | null {
  const upperMethod = method.toUpperCase();

  // Exact match first (fast path)
  const exactKey = `${upperMethod} ${path}`;
  if (endpoints[exactKey]) return endpoints[exactKey];

  // Wildcard method exact path
  const wildcardKey = `* ${path}`;
  if (endpoints[wildcardKey]) return endpoints[wildcardKey];

  // Pattern matching
  for (const key of Object.keys(endpoints)) {
    const spaceIdx = key.indexOf(" ");
    if (spaceIdx === -1) continue;

    const keyMethod = key.slice(0, spaceIdx).toUpperCase();
    const keyPath = key.slice(spaceIdx + 1);

    if (keyMethod !== "*" && keyMethod !== upperMethod) continue;
    if (matchPath(keyPath, path)) return endpoints[key];
  }

  return null;
}

/**
 * Match a path pattern against an actual path.
 * Supports :param segments and trailing * glob.
 */
function matchPath(pattern: string, actual: string): boolean {
  const patternParts = pattern.split("/").filter(Boolean);
  const actualParts = actual.split("/").filter(Boolean);

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];

    // Trailing wildcard matches everything remaining
    if (p === "*") return true;

    // Ran out of actual segments
    if (i >= actualParts.length) return false;

    // Named param matches any single segment
    if (p.startsWith(":")) continue;

    // Literal match
    if (p !== actualParts[i]) return false;
  }

  return patternParts.length === actualParts.length;
}

// --- Price parsing ---

/**
 * Parse a price string to a numeric value.
 * Supports: "$0.01", "0.01", "100"
 */
export function parsePriceString(price: string): number {
  const cleaned = price.trim().replace(/^\$/, "").trim();
  const value = Number(cleaned);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid price: "${price}"`);
  }
  return value;
}

/**
 * Convert a human-readable price to atomic units for a given asset.
 * "$0.01" with 6 decimals → "10000"
 */
export function toAtomicUnits(price: string, decimals: number): string {
  const value = parsePriceString(price);
  const atomic = BigInt(Math.round(value * 10 ** decimals));
  return atomic.toString();
}

/**
 * Resolve a Price value (which may be a function) to a concrete PriceValue.
 */
export async function resolvePrice(price: Price, ctx: RequestContext): Promise<PriceValue> {
  if (typeof price === "function") {
    return await price(ctx);
  }
  return price;
}

// --- PayTo detection and expansion ---

/** Detect if a string is an EVM address (0x-prefixed hex). */
export function isEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * True when `value` is the `{ evm?, solana? }` shorthand. Used to
 * disambiguate from a CAIP-2 record like `{ "eip155:8453": "0x..." }`.
 */
export function isPayToShorthand(value: unknown): value is PayToShorthand {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k === "evm" || k === "solana");
}

/**
 * Expand a PayToValue into a CAIP-2 per-network record.
 * - string "0x..." → spread across EVM networks for the env
 * - string (non-0x) → spread across SVM networks for the env
 * - `{ evm, solana }` shorthand → each address spread across its family
 * - CAIP-2 record → returned as-is
 */
export function expandPayTo(value: PayToValue, testnet: boolean): Record<string, string> {
  const env = testnet ? "testnet" : "mainnet";

  // Normalize bare-string and shorthand into a uniform `{ evm?, solana? }` shape.
  // CAIP-2 records pass through unchanged.
  let shorthand: PayToShorthand | undefined;
  if (typeof value === "string") {
    shorthand = isEvmAddress(value) ? { evm: value } : { solana: value };
  } else if (isPayToShorthand(value)) {
    shorthand = value;
  } else {
    return value as Record<string, string>;
  }

  const result: Record<string, string> = {};
  if (shorthand.evm) {
    for (const network of EVM_NETWORKS[env]) result[network] = shorthand.evm;
  }
  if (shorthand.solana) {
    for (const network of SVM_NETWORKS[env]) result[network] = shorthand.solana;
  }
  return result;
}

/**
 * Infer which networks are available based on a PayTo value.
 */
export function inferNetworks(value: PayToValue, testnet: boolean): string[] {
  const expanded = expandPayTo(value, testnet);
  return Object.keys(expanded);
}

// --- Asset resolution ---

/**
 * Build a merged asset registry from built-in assets and user-provided assets.
 * Custom asset objects are registered by name. Strings reference existing entries.
 */
export function buildAssetRegistry(userAssets?: Asset[]): AssetRegistry {
  const registry: AssetRegistry = { ...BUILT_IN_ASSETS };

  if (!userAssets) return registry;

  for (const asset of userAssets) {
    if (typeof asset === "object") {
      registry[asset.name] = asset;
    }
    // String references are validated at resolve time, not registration time
  }

  return registry;
}

/**
 * Resolve asset names to full definitions from the registry.
 * When price is a Record, the keys define which assets are accepted.
 * Otherwise, use the explicit assets array or fall back to defaults.
 */
export function resolveAssets(
  resolvedPrice: PriceValue,
  endpointAssets: Asset[] | undefined,
  registry: AssetRegistry,
  defaultAssets: string[] = ["USDC"],
): CustomAssetDef[] {
  let assetNames: string[];

  if (typeof resolvedPrice === "object") {
    // Price record keys define accepted assets
    assetNames = Object.keys(resolvedPrice);
  } else if (endpointAssets) {
    // Explicit assets array — register any inline definitions and collect names
    assetNames = endpointAssets.map((a) => (typeof a === "object" ? a.name : a));
    // Register inline definitions
    for (const a of endpointAssets) {
      if (typeof a === "object" && !registry[a.name]) {
        registry[a.name] = a;
      }
    }
  } else {
    assetNames = defaultAssets;
  }

  const resolved: CustomAssetDef[] = [];
  for (const name of assetNames) {
    const def = registry[name];
    if (!def) {
      throw new Error(
        `Unknown asset "${name}". Define it in the assets config or use a built-in (USDC, USDT).`,
      );
    }
    resolved.push(def);
  }

  return resolved;
}
