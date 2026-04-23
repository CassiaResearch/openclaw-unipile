import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Log } from "../src/log.js";
import { setStorageHomeForTests } from "../src/rateLimit/storage.js";
import type { UnipileConfig } from "../src/types.js";

/**
 * Config factory for tests. Defaults to tight caps so tests exhaust budgets
 * quickly, jitter is 0 (fake timers otherwise hang on the sleep), and TZ is
 * UTC so weekday/hour math is deterministic regardless of host TZ.
 */
export function makeConfig(overrides: Partial<UnipileConfig> = {}): UnipileConfig {
  return {
    enabled: true,
    dsn: "https://test.unipile.com",
    apiKey: "test-key",
    accountId: "test-account",
    accountTier: "sales_navigator",
    limits: {
      invitationsPerDay: 80,
      invitationsPerWeek: 200,
      invitationsPerMonth: 600,
      profileReadsPerDay: 100,
      profileReadsPerMonth: 3000,
      searchResultsPerDay: 2500,
      searchResultsPerMonth: 50000,
      messagesPerDay: 100,
      messagesPerMonth: 2000,
      defaultPerDay: 100,
      defaultPerMonth: 2000,
    },
    pacing: {
      jitterMinMs: 0,
      jitterMaxMs: 0,
      invitationMinSpacingSec: 90,
      pollingCooldownHours: 4,
    },
    workingHours: {
      start: "09:00",
      end: "18:00",
      timezone: "UTC",
      days: ["mon", "tue", "wed", "thu", "fri"],
    },
    telemetry: { eventRingSize: 100 },
    debug: false,
    ...overrides,
  };
}

export const silentLog: Log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** Redirect usage.json to a fresh temp dir. Call cleanupStorage in afterEach. */
export function useTempStorage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unipile-test-"));
  setStorageHomeForTests(dir);
  return dir;
}

export function cleanupStorage(dir: string): void {
  setStorageHomeForTests(undefined);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
