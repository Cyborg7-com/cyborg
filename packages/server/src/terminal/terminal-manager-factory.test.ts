import { afterEach, describe, expect, test } from "vitest";

import { isPtyHostEnabled } from "./terminal-manager-factory.js";

const ENV_KEY = "CYBORG7_PTY_HOST";

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}

describe("isPtyHostEnabled (default ON, opt out with CYBORG7_PTY_HOST=0)", () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    setEnv(original);
  });

  test("enabled by default when the env var is unset", () => {
    setEnv(undefined);
    expect(isPtyHostEnabled()).toBe(true);
  });

  test("enabled when the env var is empty", () => {
    setEnv("");
    expect(isPtyHostEnabled()).toBe(true);
  });

  test.each(["1", "true", "on", "yes", "anything", "TRUE", "  1  "])(
    "enabled for non-disable value %j",
    (value) => {
      setEnv(value);
      expect(isPtyHostEnabled()).toBe(true);
    },
  );

  test.each(["0", "false", "off", "FALSE", "Off", "  0  "])(
    "disabled (escape hatch) for %j",
    (value) => {
      setEnv(value);
      expect(isPtyHostEnabled()).toBe(false);
    },
  );
});
