import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetch, ProxyAgent } from "undici";
import {
  buildProxyUsername,
  checkExitIpInputShape,
  checkExitIpInputSchema,
  exitIpResponseSchema,
  failure,
  fetchPageInputShape,
  fetchPageInputSchema,
  htmlToText,
  readResponseText,
  ResponseBodyTooLargeError,
  statusFailure,
  success,
  truncate,
  validationFailure
} from "./lib/helpers.js";

const PROXY_HOST = process.env.DI_PROXY_HOST || "gw.dataimpulse.com";
const PROXY_PORT = Number(process.env.DI_PROXY_PORT) || 823;
// Targeting (country/city/session en el username) solo aplica a la gateway de
// DataImpulse. Otros proveedores (ej. Webshare) usan user/pass fijos y
// rechazan los sufijos __cr.XX / city.XX / sessid.XX.
const SUPPORTS_TARGETING = PROXY_HOST === "gw.dataimpulse.com";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 10;
const EXIT_IP_ENDPOINT = "https://api.ipify.org?format=json";

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9"
};

class RequestValidationError extends Error {}

const credentials = loadCredentials();
const server = new McpServer({
  name: "dataimpulse-mcp",
  version: "0.1.0"
});

server.registerTool(
  "fetch_page",
  {
    title: "Fetch Page",
    description: "Fetch a public HTTP(S) page through a DataImpulse residential proxy.",
    inputSchema: fetchPageInputShape
  },
  async (input) => {
    const parsed = fetchPageInputSchema.safeParse(input);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }

    return fetchPage(parsed.data);
  }
);

server.registerTool(
  "check_exit_ip",
  {
    title: "Check Exit IP",
    description: "Return the public IP assigned by the current DataImpulse proxy targeting.",
    inputSchema: checkExitIpInputShape
  },
  async (input) => {
    const parsed = checkExitIpInputSchema.safeParse(input);
    if (!parsed.success) {
      return validationFailure(parsed.error);
    }

    return checkExitIp(parsed.data);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

function loadCredentials() {
  const username = process.env.DI_USER;
  const password = process.env.DI_PASS;

  if (!username || !password) {
    console.error("DataImpulse MCP requires both DI_USER and DI_PASS environment variables.");
    process.exit(1);
  }

  return { username, password };
}

async function fetchPage({ url, country, city, session, raw = false }) {
  try {
    const destination = await assertPublicDestination(url);

    return await withProxy({ country, city, session }, async (dispatcher) => {
      const response = await fetchFollowingPublicRedirects(destination, dispatcher, BROWSER_HEADERS);
      const body = await readResponseText(response);

      if (!response.ok) {
        return statusFailure(response.status, body);
      }

      return success(raw ? truncate(body) : truncate(htmlToText(body)));
    });
  } catch (error) {
    return requestFailure(error);
  }
}

async function checkExitIp({ country, session }) {
  try {
    const endpoint = await assertPublicDestination(EXIT_IP_ENDPOINT);

    return await withProxy({ country, session }, async (dispatcher) => {
      const response = await fetchFollowingPublicRedirects(endpoint, dispatcher, {
        ...BROWSER_HEADERS,
        accept: "application/json, text/plain, */*"
      });

      const body = await readResponseText(response);
      if (!response.ok) {
        return statusFailure(response.status, body);
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        return failure("The exit-IP service returned invalid JSON.");
      }

      const payload = exitIpResponseSchema.safeParse(parsedBody);
      if (!payload.success) {
        return failure("The exit-IP service returned an invalid response.");
      }

      return success(`Exit IP: ${payload.data.ip}`);
    });
  } catch (error) {
    return requestFailure(error);
  }
}

async function withProxy(targeting, action) {
  const dispatcher = createProxyAgent(targeting);

  try {
    return await action(dispatcher);
  } finally {
    // Each request owns its agent so its pooled sockets cannot outlive the call.
    dispatcher.destroy();
  }
}

function createProxyAgent({ country, city, session }) {
  const proxyUrl = new URL(`http://${PROXY_HOST}:${PROXY_PORT}`);
  proxyUrl.username = SUPPORTS_TARGETING
    ? buildProxyUsername(credentials.username, { country, city, session })
    : credentials.username;
  proxyUrl.password = credentials.password;

  return new ProxyAgent(proxyUrl.toString());
}

async function fetchFollowingPublicRedirects(initialUrl, dispatcher, headers) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let currentUrl = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(currentUrl, {
      dispatcher,
      headers,
      redirect: "manual",
      signal
    });

    const location = response.headers.get("location");
    if (!isRedirect(response.status) || !location) {
      return response;
    }

    if (redirects === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new RequestValidationError("Too many redirects.");
    }

    await response.body?.cancel();
    currentUrl = await assertPublicDestination(new URL(location, currentUrl).toString());
  }

  throw new RequestValidationError("Too many redirects.");
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function assertPublicDestination(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new RequestValidationError("The URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RequestValidationError("Only public HTTP and HTTPS URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new RequestValidationError("URLs with credentials are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isForbiddenHostname(hostname)) {
    throw new RequestValidationError("The destination must not use a local, private, or metadata hostname.");
  }

  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new RequestValidationError("The destination must resolve to a public address.");
    }

    return url;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new RequestValidationError("The destination host could not be resolved.");
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new RequestValidationError("The destination must resolve only to public addresses.");
  }

  return url;
}

function isForbiddenHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata" ||
    hostname === "instance-data" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".metadata.google.internal")
  );
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    return isPublicIpv4(address);
  }

  if (isIP(address) === 6) {
    return isPublicIpv6(address);
  }

  return false;
}

function isPublicIpv4(address) {
  const [first, second] = address.split(".").map(Number);

  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return false;
  }

  if (first === 100 && second >= 64 && second <= 127) {
    return false;
  }

  if (first === 169 && second === 254) {
    return false;
  }

  if (first === 172 && second >= 16 && second <= 31) {
    return false;
  }

  if (first === 192 && (second === 0 || second === 168)) {
    return false;
  }

  if (first === 198 && (second === 18 || second === 19 || second === 51)) {
    return false;
  }

  return !(first === 203 && second === 0);
}

function isPublicIpv6(address) {
  const normalized = address.toLowerCase();
  const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);

  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("100:") ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2002:") ||
    normalized.startsWith("3fff:") ||
    normalized.startsWith("64:ff9b:")
  ) {
    return false;
  }

  return (
    (firstHextet & 0xfe00) !== 0xfc00 &&
    (firstHextet & 0xffc0) !== 0xfe80 &&
    (firstHextet & 0xff00) !== 0xff00
  );
}

function requestFailure(error) {
  if (error instanceof RequestValidationError) {
    return failure(error.message);
  }

  if (error instanceof ResponseBodyTooLargeError) {
    return failure("Response body exceeds the 1 MiB limit. Request a smaller resource and retry.");
  }

  if (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    error?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return failure("Request timed out after 45 seconds.");
  }

  return failure("Network request failed. Check the destination and proxy availability, then retry.");
}
