import { UnipileClient } from "unipile-node-sdk";
import type { UnipileConfig } from "./types.js";

let cached: { dsn: string; apiKey: string; client: UnipileClient } | null = null;

export function getClient(cfg: UnipileConfig): UnipileClient {
  if (cached && cached.dsn === cfg.dsn && cached.apiKey === cfg.apiKey) {
    return cached.client;
  }
  const client = new UnipileClient(cfg.dsn, cfg.apiKey);
  cached = { dsn: cfg.dsn, apiKey: cfg.apiKey, client };
  return client;
}
