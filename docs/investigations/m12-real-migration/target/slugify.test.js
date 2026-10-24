import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/index.js";
import * as direct from "../src/utils/slugify.js";

test("coerces input", () => {
  assert.equal(slugify(null), "");
  assert.equal(slugify(undefined), "");
  assert.equal(slugify(42), "42");
  assert.equal(slugify("x", null), "x");
});

test("folds unicode and rewrites text", () => {
  assert.equal(slugify("  Crème Brûlée!! "), "creme-brulee");
  assert.equal(slugify("Tom & Jerry"), "tom-and-jerry");
  assert.equal(slugify("Don't stop"), "dont-stop");
  assert.equal(slugify("It’s here"), "its-here");
});

test("joins with separator", () => {
  assert.equal(slugify("a--b__c"), "a-b-c");
  assert.equal(slugify("Hello World", { separator: "_" }), "hello_world");
  assert.equal(slugify("Hello World", { separator: "" }), "helloworld");
  assert.equal(slugify("Hello World", { separator: 5 }), "hello5world");
});

test("maxLength never ends on a separator", () => {
  assert.equal(slugify("Hello World, Again", { maxLength: 6 }), "hello");
  assert.equal(slugify("Hello World", { separator: "--", maxLength: 7 }), "hello");
  assert.equal(slugify("Hello", { maxLength: 0 }), "");
  assert.equal(slugify("Hello World", { maxLength: -1 }), "hello-world");
  assert.equal(slugify("Hello World", { maxLength: "5" }), "hello-world");
});

test("export surface", () => {
  assert.equal(direct.default, direct.slugify);
  assert.equal(slugify, direct.slugify);
});
