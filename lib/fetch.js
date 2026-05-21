const RETRY_DELAYS_MS = [200, 600];

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeoutAndRetry(url, options = {}) {
  const {
    timeoutMs = 8000,
    retries = 2,
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
