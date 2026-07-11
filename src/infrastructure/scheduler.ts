import type { Scheduler } from "../application/ports.ts";

export class SystemScheduler implements Scheduler {
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("sleep aborted"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);
      timeout.unref?.();

      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(new Error("sleep aborted"));
        },
        { once: true },
      );
    });
  }
}
