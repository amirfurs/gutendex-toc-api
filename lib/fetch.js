const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const DEFAULT_RETRIES = Number(process.env.UPSTREAM_RETRIES || 3);
const RETRY_DELAYS_MS = [300, 900, 1800];

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeoutAndRetry(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelays = RETRY_DELAYS_MS,
    ...fetchOptions
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status >= 500 && attempt < retries) {
        await sleep(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 300);
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) {
        await sleep(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 300);
        continue;
      }
    }
  }

  const reason = lastError?.name === "AbortError" ? "Request timed out" : lastError?.message || "Request failed";
  throw new Error(`${reason} after ${retries + 1} attempts`);
}
