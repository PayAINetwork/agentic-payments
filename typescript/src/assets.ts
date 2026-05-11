import type { AssetRegistry, CustomAssetDef } from "./types.js";

/**
 * Built-in asset registry — ships with the SDK.
 * Contract addresses for common stablecoins across supported networks.
 */

/**
 * USDC covers every PayAI-supported x402 network, including chains where the
 * deployed stablecoin is a bridged variant or (for KiteAI testnet) an
 * alternative USD-pegged token. Users configure `assets: ["USDC"]` and the
 * SDK transparently uses whichever deployment is canonical per chain.
 */
export const USDC: CustomAssetDef = {
  name: "USDC",
  addresses: {
    // --- EVM mainnets ---
    "eip155:8453": {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      eip712Name: "USD Coin", // Base mainnet USDC
    },
    "eip155:43114": {
      address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      decimals: 6,
      eip712Name: "USD Coin", // Avalanche C-Chain USDC
    },
    "eip155:4689": {
      address: "0x3B2bf2b523f54C4E454F08Aa286D03115aFF326c",
      decimals: 6, // IoTeX USDC
    },
    "eip155:1329": {
      address: "0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1",
      decimals: 6, // Sei USDC
    },
    "eip155:137": {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      decimals: 6,
      eip712Name: "USD Coin", // Polygon USDC
    },
    "eip155:3338": {
      address: "0x7A98288740407E1A0db5E18C4BE9a6F42FE77e40",
      decimals: 6, // Peaq USDC
    },
    "eip155:196": {
      address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
      decimals: 6, // XLayer USDC
    },
    "eip155:1187947933": {
      address: "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
      decimals: 6,
      eip712Name: "Bridged USDC (SKALE Bridge)", // Skale mainnet
    },
    "eip155:2366": {
      address: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
      decimals: 6,
      eip712Name: "Bridged USDC (Kite AI)", // KiteAI mainnet
    },

    // --- EVM testnets ---
    "eip155:84532": {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6, // Base Sepolia USDC
    },
    "eip155:43113": {
      address: "0x5425890298aed601595a70AB815c96711a31Bc65",
      decimals: 6, // Avalanche Fuji USDC
    },
    "eip155:713715": {
      address: "0x4E4a29f76cD0dFf2A4e5E56d7a065E0aF33f32e2",
      decimals: 6, // Sei testnet USDC
    },
    "eip155:80002": {
      address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      decimals: 6, // Polygon Amoy USDC
    },
    "eip155:1952": {
      address: "0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d",
      decimals: 6, // XLayer testnet USDC
    },
    "eip155:324705682": {
      address: "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",
      decimals: 6,
      eip712Name: "Bridged USDC (SKALE Bridge)", // Skale testnet
    },
    // KiteAI testnet uses pieUSD as its USDC-equivalent: different token,
    // different decimals (18, not 6), different EIP-712 domain. We surface
    // it under USDC so users don't have to special-case KiteAI.
    "eip155:2368": {
      address: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
      decimals: 18,
      eip712Name: "pieUSD",
      eip712Version: "1",
    },

    // --- SVM ---
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6, // Solana mainnet-beta
    },
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      decimals: 6, // Solana devnet
    },
  },
};

export const USDT: CustomAssetDef = {
  name: "USDT",
  addresses: {
    "eip155:8453": {
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimals: 6, // Base mainnet USDT
    },
    "eip155:84532": {
      address: "0x00BF01Ce147E501Ac6ae1C046cE9754f13DB7600",
      decimals: 6, // Base Sepolia USDT
    },
  },
};

export const PATH_USD: CustomAssetDef = {
  name: "pathUSD",
  addresses: {
    "eip155:4217": {
      address: "0x20c0000000000000000000000000000000000000",
      decimals: 6, // Tempo mainnet
    },
    "eip155:42431": {
      address: "0x20c0000000000000000000000000000000000000",
      decimals: 6, // Tempo testnet
    },
  },
};

export const CASH: CustomAssetDef = {
  name: "CASH",
  addresses: {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
      address: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
      decimals: 6, // Solana mainnet — Phantom CASH stablecoin
    },
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      decimals: 6, // Solana devnet — USDC substitute (CASH has no devnet deployment)
    },
  },
};

export const BUILT_IN_ASSETS: AssetRegistry = {
  USDC,
  USDT,
  CASH,
  pathUSD: PATH_USD,
};

/**
 * EVM networks PayAI's x402 facilitator can settle payments on.
 * Sourced from the facilitator's /kinds endpoint, v2 entries only.
 */
export const X402_EVM_NETWORKS = {
  mainnet: [
    "eip155:8453", // Base
    "eip155:43114", // Avalanche C-Chain
    "eip155:4689", // IoTeX
    "eip155:1329", // Sei
    "eip155:137", // Polygon
    "eip155:3338", // Peaq
    "eip155:196", // XLayer
    "eip155:1187947933", // Skale (skale-base)
    "eip155:2366", // KiteAI
  ],
  testnet: [
    "eip155:84532", // Base Sepolia
    "eip155:43113", // Avalanche Fuji
    "eip155:713715", // Sei testnet
    "eip155:80002", // Polygon Amoy
    "eip155:1952", // XLayer testnet
    "eip155:324705682", // Skale (skale-base-sepolia)
    "eip155:2368", // KiteAI testnet
  ],
} as const;

/**
 * Tempo chain IDs — MPP is only supported on these networks.
 * Not part of PayAI's x402 support; x402 settlement on Tempo is skipped.
 */
export const TEMPO_NETWORKS = {
  mainnet: "eip155:4217",
  testnet: "eip155:42431",
} as const;

/**
 * All EVM networks the SDK knows about. Union of PayAI-supported x402 EVM
 * networks and Tempo (MPP-only). Used for `payTo` address expansion.
 */
export const EVM_NETWORKS = {
  mainnet: [...X402_EVM_NETWORKS.mainnet, TEMPO_NETWORKS.mainnet],
  testnet: [...X402_EVM_NETWORKS.testnet, TEMPO_NETWORKS.testnet],
} as const;

/** SVM networks PayAI's x402 facilitator can settle on. */
export const SVM_NETWORKS = {
  mainnet: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  testnet: ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
} as const;

/**
 * All networks PayAI's x402 facilitator can settle on, by environment.
 * The x402 adapter uses this to filter challenge emission — only networks
 * actually settleable end up in the 402 response.
 */
export const X402_SUPPORTED_NETWORKS = {
  mainnet: [...X402_EVM_NETWORKS.mainnet, ...SVM_NETWORKS.mainnet],
  testnet: [...X402_EVM_NETWORKS.testnet, ...SVM_NETWORKS.testnet],
} as const;

/** All supported networks */
export const ALL_NETWORKS = {
  mainnet: [...EVM_NETWORKS.mainnet, ...SVM_NETWORKS.mainnet],
  testnet: [...EVM_NETWORKS.testnet, ...SVM_NETWORKS.testnet],
} as const;

/**
 * Default facilitator URL for x402.
 *
 * PayAI's facilitator routes both mainnet and testnet payments through the
 * same endpoint — it identifies which env a payment targets from the
 * `network` field in the payment payload. Use the `live` config flag to
 * choose which set of chains gets advertised in challenges; the facilitator
 * URL stays the same.
 */
export const DEFAULT_FACILITATOR_URL = "https://facilitator.payai.network";
export const DEFAULT_TESTNET_FACILITATOR_URL = "https://facilitator.payai.network";
