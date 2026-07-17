const OFFICIAL_BASE_URL = "https://api.up.com.au/api/v1/";
const DEFAULT_TIMEOUT_MS = 20_000;

export class UpApiError extends Error {
  constructor(message, { code = "UP_API_ERROR", status = null, errors = [] } = {}) {
    super(message);
    this.name = "UpApiError";
    this.code = code;
    this.status = status;
    this.errors = errors;
  }

  safeDetails() {
    return {
      code: this.code,
      status: this.status,
      errors: this.errors.map((error) => ({
        status: error?.status,
        title: error?.title,
        detail: error?.detail,
        source: error?.source,
      })),
    };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function objectQuery(url, query = {}) {
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(name, String(value));
  }
  return url;
}

function safeErrors(body) {
  return Array.isArray(body?.errors) ? body.errors.slice(0, 5) : [];
}

export class UpApiClient {
  constructor({
    credentials,
    baseURL = OFFICIAL_BASE_URL,
    fetchImpl = globalThis.fetch,
    sleep = delay,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (!credentials) {
      throw new TypeError("credentials is required");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetch implementation is required");
    }
    this.credentials = credentials;
    this.baseURL = new URL(baseURL);
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
  }

  buildURL(pathOrURL, query) {
    const url = new URL(pathOrURL, this.baseURL);
    if (
      url.origin !== this.baseURL.origin ||
      !url.pathname.startsWith(this.baseURL.pathname)
    ) {
      throw new UpApiError("Refusing to send credentials outside the configured Up API origin.", {
        code: "UNSAFE_URL",
      });
    }
    if (url.username || url.password) {
      throw new UpApiError("Refusing a URL containing user information.", { code: "UNSAFE_URL" });
    }
    return objectQuery(url, query);
  }

  async request(
    pathOrURL,
    { method = "GET", query, body, idempotent = method === "GET", maxRetries = 2 } = {},
  ) {
    const url = this.buildURL(pathOrURL, query);
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.credentials.getToken();
      const headers = new Headers({ Accept: "application/json" });
      headers.set("Authorization", `Bearer ${token.toString("utf8")}`);
      let payload;
      if (body !== undefined) {
        headers.set("Content-Type", "application/json");
        payload = JSON.stringify(body);
      }

      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: payload,
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        headers.delete("Authorization");
        if (idempotent && attempt < maxRetries) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new UpApiError("The Up API request could not be completed.", {
          code: error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
        });
      } finally {
        headers.delete("Authorization");
      }

      let parsed = null;
      if (response.status !== 204) {
        const text = await response.text();
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new UpApiError("The Up API returned an invalid JSON response.", {
              code: "INVALID_RESPONSE",
              status: response.status,
            });
          }
        }
      }

      if (response.ok) {
        return {
          status: response.status,
          body: parsed,
          rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
        };
      }
      if (response.status === 401) {
        this.credentials.clear();
        throw new UpApiError(
          "The Up token was rejected. Its in-memory copy was cleared; rotate or replace the stored token, then retry.",
          { code: "UNAUTHORIZED", status: 401, errors: safeErrors(parsed) },
        );
      }
      if (
        idempotent &&
        attempt < maxRetries &&
        (response.status === 429 || [500, 502, 503, 504].includes(response.status))
      ) {
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      throw new UpApiError("The Up API rejected the request.", {
        code: response.status === 429 ? "RATE_LIMITED" : "REQUEST_REJECTED",
        status: response.status,
        errors: safeErrors(parsed),
      });
    }
  }

  async paginate(pathOrURL, { query, maxPages = 1 } = {}) {
    const items = [];
    let next = this.buildURL(pathOrURL, query).toString();
    let pages = 0;
    let rateLimitRemaining = null;
    while (next && pages < maxPages) {
      const response = await this.request(next);
      const pageItems = Array.isArray(response.body?.data) ? response.body.data : [];
      items.push(...pageItems);
      pages += 1;
      rateLimitRemaining = response.rateLimitRemaining;
      next = response.body?.links?.next || null;
      if (next) {
        this.buildURL(next);
      }
    }
    return {
      items,
      pages,
      nextPageAvailable: next !== null,
      rateLimitRemaining,
    };
  }
}

export const upApiConstants = Object.freeze({
  officialBaseURL: OFFICIAL_BASE_URL,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
});
