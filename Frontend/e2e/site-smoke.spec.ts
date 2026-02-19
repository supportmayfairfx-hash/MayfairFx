import { expect, test } from "@playwright/test";

const APP_ROUTES = ["/dashboard", "/markets", "/portfolio", "/progress", "/chart", "/blog", "/contact"];

const PUBLIC_API_PATHS = [
  "/health",
  "/api/auth/status",
  "/api/menu",
  "/api/markets/snapshot",
  "/api/markets/pairs",
  "/api/chart-data?symbol=BTCUSD&interval=1h&limit=64",
  "/api/photos"
];

const ALLOWED_ERROR_SNIPPETS = [
  "favicon",
  "font-awesome",
  "ERR_BLOCKED_BY_CLIENT",
  "Failed to fetch"
];

function isAllowedConsoleError(text: string) {
  const t = text.toLowerCase();
  return ALLOWED_ERROR_SNIPPETS.some((s) => t.includes(s.toLowerCase()));
}

function toTimeLeftSeconds(label: string): number | null {
  const m = String(label).match(/(\d+)h\s+(\d+)m\s+(\d+)s/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

test.describe("Site crawl", () => {
  for (const route of APP_ROUTES) {
    test(`route ${route} renders without boot/runtime errors`, async ({ page }) => {
      const runtimeErrors: string[] = [];
      const consoleErrors: string[] = [];

      page.on("pageerror", (err) => runtimeErrors.push(String(err?.stack || err?.message || err)));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (isAllowedConsoleError(text)) return;
        consoleErrors.push(text);
      });

      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root")).toBeVisible();
      await page.waitForTimeout(1200);
      await expect(page.locator("#__boot_error__")).toHaveCount(0);

      expect(runtimeErrors, `runtime errors on ${route}`).toEqual([]);
      expect(consoleErrors, `console errors on ${route}`).toEqual([]);
    });
  }
});

test("public APIs return expected status codes", async ({ request }) => {
  for (const path of PUBLIC_API_PATHS) {
    const res = await request.get(path);
    expect.soft(res.status(), `${path} status`).toBe(200);
  }
});

test("progress does not reset when navigating away and back (cached session path)", async ({ context, page }) => {
  const nowIso = new Date().toISOString();
  const farFutureIso = "2099-01-01T00:00:00.000Z";
  const user = { id: "e2e-user-1", email: "e2e@example.com", first_name: "E2E", created_at: farFutureIso };
  const profile = {
    user_id: "e2e-user-1",
    initial_capital: 500,
    initial_asset: "USD",
    initial_units: null,
    created_at: nowIso,
    updated_at: nowIso
  };

  await context.addInitScript(
    ({ u, p }) => {
      localStorage.setItem("tf_user_v1", JSON.stringify(u));
      localStorage.setItem("tf_profile_latest_v1", JSON.stringify(p));
      localStorage.setItem(`tf_profile_v1:${u.id}`, JSON.stringify(p));
    },
    { u: user, p: profile }
  );

  await page.goto("/progress", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pool Trading" })).toBeVisible();
  await page.waitForTimeout(2200);

  const endText1 = await page.locator(".progressMeta .muted").nth(1).innerText();
  const timeLeft1 = await page.locator(".progressBadge .mono").innerText();
  const t1 = toTimeLeftSeconds(timeLeft1);
  expect(t1, "first time-left parse").not.toBeNull();

  await page.goto("/portfolio", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Your holdings, performance, and risk/i })).toBeVisible();

  await page.goto("/progress", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pool Trading" })).toBeVisible();
  await page.waitForTimeout(1200);

  const endText2 = await page.locator(".progressMeta .muted").nth(1).innerText();
  const timeLeft2 = await page.locator(".progressBadge .mono").innerText();
  const t2 = toTimeLeftSeconds(timeLeft2);
  expect(t2, "second time-left parse").not.toBeNull();

  // End timestamp should remain stable across page remounts.
  expect(endText2).toBe(endText1);

  // Time left should not jump upward by more than a tiny scheduling tolerance.
  expect((t2 as number) - (t1 as number)).toBeLessThanOrEqual(2);
});

test("profile dropdown logout clears cached session and returns to guest state", async ({ page }) => {
  let loggedIn = true;
  const user = { id: "logout-e2e-user", email: "logout-e2e@example.com", first_name: "Logout", created_at: new Date().toISOString() };

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: loggedIn ? user : null })
    });
  });
  await page.route("**/api/auth/logout", async (route) => {
    loggedIn = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /user profile/i })).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem("tf_user_v1", JSON.stringify({ id: "logout-e2e-user", email: "logout-e2e@example.com", created_at: new Date().toISOString() }));
    localStorage.setItem("tf_profile_latest_v1", JSON.stringify({ user_id: "logout-e2e-user" }));
    localStorage.setItem("tf_profile_v1:logout-e2e-user", JSON.stringify({ user_id: "logout-e2e-user" }));
  });

  await page.getByRole("button", { name: /user profile/i }).click();
  await page.getByRole("menu", { name: "Profile menu" }).getByText("Logout", { exact: true }).click();

  await expect(page.locator(".whoSub")).toContainText("Not signed in");

  await page.getByRole("button", { name: /user profile/i }).click();
  await expect(page.getByRole("menu", { name: "Profile menu" }).getByText("Login", { exact: true })).toBeVisible();
  await expect(page.getByRole("menu", { name: "Profile menu" }).getByText("Logout", { exact: true })).toHaveCount(0);

  const cacheState = await page.evaluate(() => ({
    user: localStorage.getItem("tf_user_v1"),
    profileLatest: localStorage.getItem("tf_profile_latest_v1"),
    profileByUser: localStorage.getItem("tf_profile_v1:logout-e2e-user")
  }));
  expect(cacheState.user).toBeNull();
  expect(cacheState.profileLatest).toBeNull();
  expect(cacheState.profileByUser).toBeNull();
});
