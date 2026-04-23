import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingCredential, parseUnipileConfig } from "../src/config.js";
import { UnipileConfigSchema } from "../src/configSchema.js";
import { silentLog } from "./helpers.js";

describe("parseUnipileConfig — Zod-driven parse", () => {
  // Snapshot env so per-test mutations don't leak.
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    envBackup = {
      UNIPILE_DSN: process.env.UNIPILE_DSN,
      UNIPILE_API_KEY: process.env.UNIPILE_API_KEY,
      UNIPILE_ACCOUNT_ID: process.env.UNIPILE_ACCOUNT_ID,
    };
    delete process.env.UNIPILE_DSN;
    delete process.env.UNIPILE_API_KEY;
    delete process.env.UNIPILE_ACCOUNT_ID;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults everything when given an empty object", () => {
    const cfg = parseUnipileConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.accountTier).toBe("sales_navigator");
    expect(cfg.limits.invitationsPerDay).toBe(80);
    expect(cfg.pacing.invitationMinSpacingSec).toBe(90);
    expect(cfg.workingHours.start).toBe("09:00");
    expect(cfg.workingHours.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(cfg.telemetry.eventRingSize).toBe(500);
    expect(cfg.debug).toBe(false);
    // Empty credentials propagate through — missingCredential catches them.
    expect(cfg.dsn).toBe("");
    expect(cfg.apiKey).toBe("");
    expect(cfg.accountId).toBe("");
    expect(missingCredential(cfg)).toMatch(/dsn/);
  });

  it("normalizes undefined / null / array input to empty config", () => {
    expect(parseUnipileConfig(undefined).limits.invitationsPerDay).toBe(80);
    expect(parseUnipileConfig(null).limits.invitationsPerDay).toBe(80);
    expect(parseUnipileConfig([]).limits.invitationsPerDay).toBe(80);
  });

  it("coerces string booleans on enabled / debug", () => {
    expect(parseUnipileConfig({ enabled: "false" }).enabled).toBe(false);
    expect(parseUnipileConfig({ enabled: "0" }).enabled).toBe(false);
    expect(parseUnipileConfig({ enabled: "no" }).enabled).toBe(false);
    expect(parseUnipileConfig({ enabled: "yes" }).enabled).toBe(true);
    expect(parseUnipileConfig({ debug: "true" }).debug).toBe(true);
  });

  it("trims string credentials and falls back to env vars when unset", () => {
    process.env.UNIPILE_API_KEY = "  env-secret  ";
    const cfg = parseUnipileConfig({ dsn: "  https://dsn  " });
    expect(cfg.dsn).toBe("https://dsn");
    expect(cfg.apiKey).toBe("env-secret");
  });

  it("direct config value wins over env var", () => {
    process.env.UNIPILE_API_KEY = "from-env";
    const cfg = parseUnipileConfig({ apiKey: "from-config" });
    expect(cfg.apiKey).toBe("from-config");
  });

  it("rejects invalid accountTier via Zod and warns + falls back", () => {
    const warnings: string[] = [];
    const log = {
      ...silentLog,
      warn: (msg: string) => {
        warnings.push(msg);
      },
    };
    const cfg = parseUnipileConfig({ accountTier: "bogus" }, log);
    expect(cfg.accountTier).toBe("sales_navigator");
    expect(warnings.some((w) => /accountTier/.test(w))).toBe(true);
  });

  it("dedupes workingHours.days while preserving order", () => {
    const cfg = parseUnipileConfig({
      workingHours: { days: ["mon", "tue", "mon", "wed", "tue"] },
    });
    expect(cfg.workingHours.days).toEqual(["mon", "tue", "wed"]);
  });

  it("rejects bad HH:MM on workingHours.start and logs each issue", () => {
    const warnings: string[] = [];
    const log = {
      ...silentLog,
      warn: (msg: string) => {
        warnings.push(msg);
      },
    };
    const cfg = parseUnipileConfig({ workingHours: { start: "99:99", end: "not-a-time" } }, log);
    // Fallback to schema defaults.
    expect(cfg.workingHours.start).toBe("09:00");
    expect(cfg.workingHours.end).toBe("18:00");
    expect(warnings.some((w) => /start|end/.test(w))).toBe(true);
  });

  it("enforces numeric ranges on limits", () => {
    const warnings: string[] = [];
    const log = {
      ...silentLog,
      warn: (msg: string) => {
        warnings.push(msg);
      },
    };
    // Max is 200 for invitationsPerDay.
    const cfg = parseUnipileConfig({ limits: { invitationsPerDay: 9999 } }, log);
    expect(cfg.limits.invitationsPerDay).toBe(80); // default after fallback
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("UnipileConfigSchema.safeParse returns structured issues for bad input", () => {
    const res = UnipileConfigSchema.safeParse({
      accountTier: "bogus",
      limits: { invitationsPerDay: -5 },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("accountTier");
      expect(paths.some((p) => p.startsWith("limits"))).toBe(true);
    }
  });
});
