import test from "node:test";
import assert from "node:assert/strict";
import { total } from "./src/total.js";

test("zero price and quantity produce a zero total", () => {
  assert.equal(total(0, 0), 0);
});
