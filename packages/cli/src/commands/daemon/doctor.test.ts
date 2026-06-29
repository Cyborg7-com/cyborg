import { describe, it, expect } from "vitest";
import { buildDoctorReport, type DoctorFacts } from "./doctor.js";

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    home: "/home/u/.cyborg7",
    running: true,
    reachable: true,
    serverId: "srv_abc",
    installedVersion: "1.0.0",
    daemonVersion: "1.0.0",
    latestVersion: "1.0.0",
    relayConfigured: true,
    relayEndpoint: "wss://relay.example",
    ...over,
  };
}

function rowValue(report: ReturnType<typeof buildDoctorReport>, check: string): string {
  return report.rows.find((r) => r.check === check)?.value ?? "";
}

describe("buildDoctorReport (#665)", () => {
  it("healthy + up-to-date daemon reads online with no update", () => {
    const r = buildDoctorReport(facts());
    expect(r.online).toBe(true);
    expect(r.updateAvailable).toBe(false);
    expect(rowValue(r, "Status")).toBe("online");
    expect(rowValue(r, "Update available")).toBe("no (up to date)");
    expect(rowValue(r, "Server ID")).toBe("srv_abc");
  });

  it("flags an available update with the version delta", () => {
    const r = buildDoctorReport(facts({ installedVersion: "1.0.0", latestVersion: "1.2.0" }));
    expect(r.updateAvailable).toBe(true);
    expect(rowValue(r, "Update available")).toBe("yes — 1.0.0 → 1.2.0");
  });

  it("reports unknown when latest can't be resolved (offline)", () => {
    const r = buildDoctorReport(facts({ latestVersion: null }));
    expect(r.updateAvailable).toBe(false);
    expect(rowValue(r, "Update available")).toMatch(/unknown/);
  });

  it("classifies running-but-unreachable distinctly from stopped", () => {
    expect(rowValue(buildDoctorReport(facts({ reachable: false })), "Status")).toMatch(
      /unreachable/,
    );
    expect(rowValue(buildDoctorReport(facts({ running: false, reachable: false })), "Status")).toBe(
      "stopped",
    );
  });

  it("shows CLI/daemon version drift when they differ", () => {
    const r = buildDoctorReport(facts({ installedVersion: "1.1.0", daemonVersion: "1.0.0" }));
    expect(rowValue(r, "Version")).toBe("1.1.0 (CLI) / 1.0.0 (running daemon)");
  });

  it("relay row reflects configured + online, and not-configured", () => {
    expect(rowValue(buildDoctorReport(facts()), "Relay")).toMatch(/configured.*online/);
    expect(rowValue(buildDoctorReport(facts({ relayConfigured: false })), "Relay")).toBe(
      "not configured",
    );
    expect(
      rowValue(buildDoctorReport(facts({ running: false, reachable: false })), "Relay"),
    ).toMatch(/offline, connection unknown/);
  });

  it("handles a missing server-id", () => {
    expect(rowValue(buildDoctorReport(facts({ serverId: null })), "Server ID")).toBe("(none)");
  });
});
