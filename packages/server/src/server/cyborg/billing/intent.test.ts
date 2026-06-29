import { describe, it, expect } from "vitest";
import {
  resolveBillingIntent,
  deriveBillingSource,
  mapLicenseStateToBillingState,
  type BillingSource,
  type BillingState,
  type BillingPlatform,
} from "./intent.js";

const WEB_DESKTOP: BillingPlatform[] = ["web", "desktop"];
const MOBILE: BillingPlatform[] = ["ios", "android"];
const ALL_PLATFORMS: BillingPlatform[] = ["web", "desktop", "ios", "android"];

// The locked matrix, as the expected ACTION per (source,state) × surface.
// surface "wd" = web/desktop, "mob" = mobile.
interface MatrixRow {
  source: BillingSource;
  state: BillingState;
  wd: string;
  mob: string;
}
const MATRIX: MatrixRow[] = [
  { source: "none", state: "trialing", wd: "stripe_checkout", mob: "iap_purchase" },
  { source: "none", state: "expired", wd: "stripe_checkout", mob: "iap_purchase" },
  { source: "stripe", state: "trialing", wd: "stripe_checkout", mob: "iap_purchase" },
  { source: "stripe", state: "expired", wd: "stripe_checkout", mob: "iap_purchase" },
  { source: "stripe", state: "active", wd: "stripe_portal", mob: "manage_on_web" },
  { source: "iap", state: "active", wd: "manage_in_mobile", mob: "iap_manage" },
  { source: "iap", state: "expired", wd: "stripe_checkout", mob: "iap_purchase" },
  { source: "manual", state: "active", wd: "contact_admin", mob: "contact_admin" },
  { source: "manual", state: "expired", wd: "stripe_checkout", mob: "iap_purchase" },
];

describe("resolveBillingIntent — locked matrix (owner)", () => {
  for (const row of MATRIX) {
    for (const platform of WEB_DESKTOP) {
      it(`${row.source}+${row.state} on ${platform} → ${row.wd}`, () => {
        const intent = resolveBillingIntent({
          source: row.source,
          state: row.state,
          platform,
          role: "owner",
        });
        expect(intent.action).toBe(row.wd);
      });
    }
    for (const platform of MOBILE) {
      it(`${row.source}+${row.state} on ${platform} → ${row.mob}`, () => {
        const intent = resolveBillingIntent({
          source: row.source,
          state: row.state,
          platform,
          role: "owner",
        });
        expect(intent.action).toBe(row.mob);
      });
    }
  }
});

describe("resolveBillingIntent — role overlay (non-owner → owner_only)", () => {
  for (const role of ["admin", "member"] as const) {
    for (const row of MATRIX) {
      for (const platform of ALL_PLATFORMS) {
        it(`${role} on ${row.source}+${row.state}/${platform} → owner_only`, () => {
          const intent = resolveBillingIntent({
            source: row.source,
            state: row.state,
            platform,
            role,
          });
          expect(intent.action).toBe("owner_only");
          expect(intent.message).toBe(
            "Only the workspace owner can manage billing — ask the owner.",
          );
          expect(intent.ctaLabel).toBeUndefined();
        });
      }
    }
  }

  it("a non-owner on manual+active still gets owner_only (overlay wins over contact_admin)", () => {
    const intent = resolveBillingIntent({
      source: "manual",
      state: "active",
      platform: "web",
      role: "member",
    });
    expect(intent.action).toBe("owner_only");
  });
});

describe("resolveBillingIntent — exact copy assertions", () => {
  it("manage_on_web message is exact", () => {
    const intent = resolveBillingIntent({
      source: "stripe",
      state: "active",
      platform: "ios",
      role: "owner",
    });
    expect(intent.action).toBe("manage_on_web");
    expect(intent.message).toBe(
      "Your subscription is billed on the web — manage it at app.cyborg7.com",
    );
    expect(intent.ctaLabel).toBe("Open app.cyborg7.com");
  });

  it("manage_in_mobile message is exact (no cta)", () => {
    const intent = resolveBillingIntent({
      source: "iap",
      state: "active",
      platform: "web",
      role: "owner",
    });
    expect(intent.action).toBe("manage_in_mobile");
    expect(intent.message).toBe(
      "Purchased in the mobile app — manage it in App Store / Google Play",
    );
    expect(intent.ctaLabel).toBeUndefined();
  });

  it("contact_admin message is exact (no cta)", () => {
    const intent = resolveBillingIntent({
      source: "manual",
      state: "active",
      platform: "desktop",
      role: "owner",
    });
    expect(intent.action).toBe("contact_admin");
    expect(intent.message).toBe(
      "Access was granted by the Cyborg7 team — contact your administrator",
    );
    expect(intent.ctaLabel).toBeUndefined();
  });

  it("owner_only message is exact (no cta)", () => {
    const intent = resolveBillingIntent({
      source: "stripe",
      state: "active",
      platform: "web",
      role: "admin",
    });
    expect(intent.action).toBe("owner_only");
    expect(intent.message).toBe("Only the workspace owner can manage billing — ask the owner.");
    expect(intent.ctaLabel).toBeUndefined();
  });
});

describe("resolveBillingIntent — iOS vs Android store-name copy", () => {
  it("iap_purchase says App Store on iOS, Google Play on Android", () => {
    const ios = resolveBillingIntent({
      source: "none",
      state: "trialing",
      platform: "ios",
      role: "owner",
    });
    const android = resolveBillingIntent({
      source: "none",
      state: "trialing",
      platform: "android",
      role: "owner",
    });
    expect(ios.action).toBe("iap_purchase");
    expect(ios.message).toContain("App Store");
    expect(android.action).toBe("iap_purchase");
    expect(android.message).toContain("Google Play");
  });

  it("iap_manage cta + message name the right store per platform", () => {
    const ios = resolveBillingIntent({
      source: "iap",
      state: "active",
      platform: "ios",
      role: "owner",
    });
    const android = resolveBillingIntent({
      source: "iap",
      state: "active",
      platform: "android",
      role: "owner",
    });
    expect(ios.action).toBe("iap_manage");
    expect(ios.ctaLabel).toBe("Manage in App Store");
    expect(ios.message).toContain("App Store");
    expect(android.action).toBe("iap_manage");
    expect(android.ctaLabel).toBe("Manage in Google Play");
    expect(android.message).toContain("Google Play");
  });
});

describe("resolveBillingIntent — none+active dormant/full-access fallback", () => {
  it("falls through to stripe_checkout on web (client suppresses since state=active)", () => {
    const intent = resolveBillingIntent({
      source: "none",
      state: "active",
      platform: "web",
      role: "owner",
    });
    expect(intent.action).toBe("stripe_checkout");
  });

  it("falls through to iap_purchase on mobile", () => {
    const intent = resolveBillingIntent({
      source: "none",
      state: "active",
      platform: "ios",
      role: "owner",
    });
    expect(intent.action).toBe("iap_purchase");
  });
});

describe("deriveBillingSource", () => {
  it("cus_ prefix → stripe", () => {
    expect(deriveBillingSource("cus_ABC123")).toBe("stripe");
  });
  it("revenuecat: prefix → iap", () => {
    expect(deriveBillingSource("revenuecat:user-42")).toBe("iap");
  });
  it("manual_comp_grant prefix → manual", () => {
    expect(deriveBillingSource("manual_comp_grant:user-42")).toBe("manual");
    expect(deriveBillingSource("manual_comp_grant")).toBe("manual");
  });
  it("null / undefined / empty / unknown → none", () => {
    expect(deriveBillingSource(null)).toBe("none");
    expect(deriveBillingSource(undefined)).toBe("none");
    expect(deriveBillingSource("")).toBe("none");
    expect(deriveBillingSource("something_else")).toBe("none");
  });
});

describe("mapLicenseStateToBillingState", () => {
  it("trialing → trialing", () => {
    expect(mapLicenseStateToBillingState("trialing", "trialing")).toBe("trialing");
  });
  it("active → active", () => {
    expect(mapLicenseStateToBillingState("active", "active")).toBe("active");
  });
  it("paused → expired (regardless of raw status)", () => {
    expect(mapLicenseStateToBillingState("paused", "canceled")).toBe("expired");
    expect(mapLicenseStateToBillingState("paused", "past_due")).toBe("expired");
    expect(mapLicenseStateToBillingState("paused", "unpaid")).toBe("expired");
    expect(mapLicenseStateToBillingState("paused", null)).toBe("expired");
  });
});
