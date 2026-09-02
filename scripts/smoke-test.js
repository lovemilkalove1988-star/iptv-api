#!/usr/bin/env node
"use strict";

const BASE_URL = "http://127.0.0.1:3000";
const ENDPOINTS = [
  "/login",
  "/admin",
  "/admin/channels",
  "/admin/channels/sources",
  "/admin/clients",
  "/client/pair",
  "/client/recover-device",
  "/client/channels",
  "/api/v1/health",
  "/api/v1/client/public/channels"
];

async function check(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(BASE_URL + path, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
    const status = response.status;
    // Unauthenticated admin/client pages may intentionally redirect to /login.
    const ok = status === 200 || (status >= 300 && status < 400);
    console.log(`${ok ? "PASS" : "FAIL"} ${status} ${path}${status >= 300 && status < 400 ? " (expected redirect)" : ""}`);
    return ok;
  } catch (error) {
    console.log(`FAIL ${error.name === "AbortError" ? "TIMEOUT" : "ERROR"} ${path}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  let passed = 0;
  for (const endpoint of ENDPOINTS) if (await check(endpoint)) passed += 1;
  const total = ENDPOINTS.length;
  if (passed === total) {
    console.log(`SMOKE PASS: ${passed}/${total}`);
    process.exitCode = 0;
  } else {
    console.log(`SMOKE FAIL: ${passed}/${total}`);
    process.exitCode = 1;
  }
})();
