/**
 * Chromium flags for the browser checks: the real GPU by default (fast, and the
 * same rendering players get); SWIFTSHADER=1 forces software rendering for
 * machines without one.
 */
export const BROWSER_ARGS = process.env.SWIFTSHADER
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
  : ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"];
