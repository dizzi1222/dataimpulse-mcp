import { z } from "zod";
import { isIP } from "node:net";

const MAX_OUTPUT_CHARACTERS = 60_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Response body exceeds the ${maxBytes.toLocaleString("en-US")} byte limit.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

const countrySchema = z.string().trim().regex(/^[A-Za-z]{2}$/, "must be a two-letter ISO country code");
const citySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "may contain only letters, numbers, hyphens, and underscores");
const sessionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "may contain only letters, numbers, hyphens, and underscores");

export const fetchPageInputShape = {
  url: z.string().url().max(2_048),
  country: countrySchema.optional(),
  city: citySchema.optional(),
  session: sessionSchema.optional(),
  raw: z.boolean().optional()
};

export const fetchPageInputSchema = z
  .object(fetchPageInputShape)
  .strict()
  .superRefine(({ country, city }, context) => {
    if (city && !country) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["city"],
        message: "requires country"
      });
    }
  });

export const checkExitIpInputShape = {
  country: countrySchema.optional(),
  session: sessionSchema.optional()
};

export const checkExitIpInputSchema = z.object(checkExitIpInputShape).strict();
export const exitIpResponseSchema = z.object({
  ip: z.string().trim().refine((value) => isIP(value) !== 0, "must contain a valid IP address")
});

export function buildProxyUsername(login, { country, city, session }) {
  const parameters = [];

  if (country) {
    parameters.push(`cr.${country.toLowerCase()}`);
  }

  if (city) {
    parameters.push(`city.${city.toLowerCase()}`);
  }

  if (session) {
    parameters.push(`sessid.${session}`);
  }

  return parameters.length === 0 ? login : `${login}__${parameters.join(";")}`;
}

export async function readResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = response.headers.get("content-length");
  if (declaredBodyExceedsLimit(contentLength, maxBytes)) {
    await cancelBody(response.body);
    throw new ResponseBodyTooLargeError(maxBytes);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let byteCount = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }

      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        throw new ResponseBodyTooLargeError(maxBytes);
      }

      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function declaredBodyExceedsLimit(contentLength, maxBytes) {
  return contentLength !== null && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(maxBytes);
}

async function cancelBody(body) {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is best-effort; the size limit remains the reported failure.
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort; preserve the original read failure.
  }
}

export function htmlToText(html) {
  const lowercaseHtml = html.toLowerCase();
  let output = "";
  let cursor = 0;

  while (cursor < html.length) {
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }

    if (html[cursor] !== "<") {
      output += html[cursor];
      cursor += 1;
      continue;
    }

    const end = findTagEnd(html, cursor + 1);
    if (end === -1) {
      output += html[cursor];
      cursor += 1;
      continue;
    }

    const token = html.slice(cursor + 1, end);
    const tagName = getTagName(token);
    const isClosingTag = /^\s*\//.test(token);

    if (!tagName) {
      cursor = end + 1;
      continue;
    }

    if (!isClosingTag && (tagName === "script" || tagName === "style")) {
      cursor = skipElement(html, lowercaseHtml, end + 1, tagName);
      continue;
    }

    if (isTextBoundaryTag(tagName)) {
      output += "\n";
    }

    cursor = end + 1;
  }

  return decodeHtmlEntities(output)
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n[ \t\f\v]+/g, "\n")
    .replace(/[ \t\f\v]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findTagEnd(html, start) {
  let quote = "";

  for (let index = start; index < html.length; index += 1) {
    const character = html[index];

    if (quote) {
      if (character === quote) {
        quote = "";
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }

  return -1;
}

function getTagName(token) {
  const match = token.match(/^\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b/);
  return match?.[1]?.toLowerCase();
}

function skipElement(html, lowercaseHtml, start, tagName) {
  let closingTag = lowercaseHtml.indexOf(`</${tagName}`, start);

  while (closingTag !== -1) {
    const end = findTagEnd(html, closingTag + 2);
    if (end === -1) {
      return html.length;
    }

    const token = html.slice(closingTag + 1, end);
    if (/^\s*\/\s*/.test(token) && getTagName(token) === tagName) {
      return end + 1;
    }

    closingTag = lowercaseHtml.indexOf(`</${tagName}`, end + 1);
  }

  return html.length;
}

function isTextBoundaryTag(tagName) {
  return /^(address|article|aside|blockquote|br|caption|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)$/.test(
    tagName
  );
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };

  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code) => {
    const normalized = code.toLowerCase();

    if (normalized in namedEntities) {
      return namedEntities[normalized];
    }

    const numericValue = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);

    try {
      return String.fromCodePoint(numericValue);
    } catch {
      return entity;
    }
  });
}

export function statusFailure(status, body) {
  const code = body.toUpperCase();

  if (status === 407 && code.includes("TRAFFIC_EXHAUSTED")) {
    return failure("HTTP 407 (TRAFFIC_EXHAUSTED): DataImpulse traffic is exhausted. Add traffic credit and retry.");
  }

  if (status === 407 && code.includes("THREADS_EXHAUSTED")) {
    return failure(
      "HTTP 407 (THREADS_EXHAUSTED): More than 2,000 concurrent connections are active. Reduce concurrency and retry."
    );
  }

  if (status === 503 && code.includes("NO_RAY")) {
    return failure("HTTP 503 (NO_RAY): No proxy IPs match the targeting. Remove city targeting and retain country only.");
  }

  if (status === 403) {
    return failure("HTTP 403: The destination site blocked the request. Retry with another country or a fixed session.");
  }

  if (status === 429) {
    return failure(
      "HTTP 429: The destination applied rate limiting or anti-bot controls. Try one new session or another country once; if it persists, access the target site directly or use another search engine. Do not retry blindly."
    );
  }

  return failure(`Request failed with HTTP ${status}. Verify the destination is available and retry.`);
}

export function validationFailure(error) {
  const details = error.issues
    .map((issue) => `${issue.path.length === 0 ? "input" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  return failure(`Invalid input: ${details}`);
}

export function success(text) {
  return {
    content: [{ type: "text", text: truncate(text) }]
  };
}

export function failure(text) {
  return {
    content: [{ type: "text", text: truncate(text) }],
    isError: true
  };
}

export function truncate(text) {
  return text.length <= MAX_OUTPUT_CHARACTERS ? text : text.slice(0, MAX_OUTPUT_CHARACTERS);
}
