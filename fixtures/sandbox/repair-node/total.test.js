import test from "node:test";
import assert from "node:assert/strict";
import { total } from "./src/total.js";
test("three items priced at 500 cents cost 1500 cents", () => assert.equal(total(500, 3), 1500));
