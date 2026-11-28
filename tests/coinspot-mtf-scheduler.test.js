import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { __test } from "../index.js";

const configuredEnv = {
  EDGE_KV: {},
  COINSPOT_READONLY_KEY: "read-only-test-key",
  COINSPOT_READONLY_SECRET: "read-only-test-secret"
};

const scheduledAtMinute = minute =>
  Date.parse(`2026-11-28T00:${String(minute).padStart(2, "0")}:00.000Z`);

test("CoinSpot MTF scheduler selects all eleven five-minute slots and reserves the top of the hour", () => {
  for (const minute of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
    assert.equal(
      __test.isCoinSpotMtfScheduleSlot({ scheduledTime: scheduledAtMinute(minute) }, configuredEnv),
      true,
      `minute ${minute} should run the CoinSpot MTF paper engine`
    );
  }

  assert.equal(
    __test.isCoinSpotMtfScheduleSlot({ scheduledTime: scheduledAtMinute(0) }, configuredEnv),
    false,
    "minute 0 is reserved for the other scheduled engines"
  );
});

test("CoinSpot MTF scheduler ignores non-five-minute cron invocations", () => {
  for (const minute of [1, 2, 3, 4, 6, 7, 9, 11, 14, 16, 59]) {
    assert.equal(
      __test.isCoinSpotMtfScheduleSlot({ scheduledTime: scheduledAtMinute(minute) }, configuredEnv),
      false,
      `minute ${minute} must not start a CoinSpot MTF scan`
    );
  }
});

test("CoinSpot MTF scheduler fails closed without KV or both read-only credentials", () => {
  const atFive = { scheduledTime: scheduledAtMinute(5) };

  assert.equal(
    __test.isCoinSpotMtfScheduleSlot(atFive, { ...configuredEnv, EDGE_KV: undefined }),
    false
  );
  assert.equal(
    __test.isCoinSpotMtfScheduleSlot(atFive, { ...configuredEnv, COINSPOT_READONLY_KEY: "" }),
    false
  );
  assert.equal(
    __test.isCoinSpotMtfScheduleSlot(atFive, { ...configuredEnv, COINSPOT_READONLY_SECRET: "" }),
    false
  );
  assert.equal(__test.isCoinSpotMtfScheduleSlot(atFive, {}), false);
});


test("CoinSpot MTF operational documentation matches the eleven deployed five-minute slots", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const checklist = await readFile(new URL("../smoke-checklist.md", import.meta.url), "utf8");
  const slots = ":05, :10, :15, :20, :25, :30, :35, :40, :45, :50 and :55";
  assert.ok(readme.includes(slots), "README must document all eleven MTF slots");
  assert.ok(checklist.includes(slots), "smoke checklist must document all eleven MTF slots");
  assert.doesNotMatch(readme, /CoinSpot runs at UTC :15, :30 and :45/);
  assert.doesNotMatch(checklist, /Verify :15, :30 and :45 run CoinSpot MTF alone/);
});
