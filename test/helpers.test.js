import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProxyUsername,
  fetchPageInputSchema,
  htmlToText,
  MAX_RESPONSE_BYTES,
  readResponseText,
  ResponseBodyTooLargeError,
  statusFailure,
  truncate
} from "../lib/helpers.js";

function errorText(response) {
  return response.content[0].text;
}

test("buildProxyUsername adds normalized targeting parameters", () => {
  assert.equal(
    buildProxyUsername("account", { country: "US", city: "New_York", session: "visit-42" }),
    "account__cr.us;city.new_york;sessid.visit-42"
  );
  assert.equal(buildProxyUsername("account", {}), "account");
});

test("fetch_page input requires a country when targeting a city", () => {
  const cityWithoutCountry = fetchPageInputSchema.safeParse({
    url: "https://example.com",
    city: "Austin"
  });
  const invalidCountry = fetchPageInputSchema.safeParse({
    url: "https://example.com",
    country: "USA"
  });

  assert.equal(cityWithoutCountry.success, false);
  assert.match(cityWithoutCountry.error.issues[0].message, /requires country/);
  assert.equal(invalidCountry.success, false);
  assert.match(invalidCountry.error.issues[0].message, /two-letter ISO country code/);
});

test("htmlToText removes executable content, decodes entities, and preserves text boundaries", () => {
  const html = "<h1>Hello&nbsp;world</h1><script>alert('hidden')</script><style>.hidden{}</style><p>A &amp; B</p>";

  assert.equal(htmlToText(html), "Hello world\n\nA & B");
});

test("truncate limits tool output to 60,000 characters", () => {
  assert.equal(truncate("x".repeat(60_001)).length, 60_000);
});

test("readResponseText decodes a normal UTF-8 stream across chunk boundaries", async () => {
  const bytes = new TextEncoder().encode("caf\u00e9");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      }
    })
  );

  assert.equal(await readResponseText(response), "caf\u00e9");
});

test("readResponseText rejects an oversized Content-Length before reading", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      }
    }),
    { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }
  );

  await assert.rejects(() => readResponseText(response), ResponseBodyTooLargeError);
  assert.equal(cancelled, true);
});

test("readResponseText cancels a stream that exceeds the byte limit", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      }
    })
  );

  await assert.rejects(() => readResponseText(response), ResponseBodyTooLargeError);
  assert.equal(cancelled, true);
});

test("status failures explain proxy capacity, targeting, blocking, and rate limits", () => {
  assert.match(errorText(statusFailure(407, "TRAFFIC_EXHAUSTED")), /Add traffic credit/);
  assert.match(errorText(statusFailure(407, "THREADS_EXHAUSTED")), /Reduce concurrency/);
  assert.match(errorText(statusFailure(503, "NO_RAY")), /Remove city targeting/);
  assert.match(errorText(statusFailure(403, "")), /another country or a fixed session/);
  assert.match(errorText(statusFailure(429, "")), /Do not retry blindly/);
});
