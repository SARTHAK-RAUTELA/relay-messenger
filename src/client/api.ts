// Thin HTTP wrapper around the Relay API (spec 5.1/5.2).

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public network: boolean,
    public retryAfterMs?: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: FetchLike,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        credentials: "same-origin",
        // Every mutation is sent as JSON (the server rejects other content types).
        headers: method === "GET" ? {} : { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      });
    } catch (e) {
      throw new ApiFailure(0, "NETWORK", "Could not reach the server.", true);
    }
    const text = await res.text().catch(() => "");
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiFailure(
        res.status,
        err.code ?? (res.status >= 500 ? "SERVER_ERROR" : "HTTP_" + res.status),
        err.message ?? "Request failed.",
        false,
        err.retryAfterMs,
        data,
      );
    }
    return data as T;
  }
}
