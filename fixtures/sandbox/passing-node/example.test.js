import assert from "node:assert/strict";
import { test } from "node:test";

test("the disposable sandbox really executes this repository", () => {
  assert.equal(6 * 7, 42);
});
