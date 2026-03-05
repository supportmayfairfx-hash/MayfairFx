import { expect, test } from "@playwright/test";

async function fillCheckout(page: any) {
  await page.getByLabel("Full Name").fill("Mary Trader");
}

async function mockQuote(page: any, amountTo = "0.015") {
  const body = JSON.stringify({
    quote: {
      amount_to: amountTo,
      source: "server"
    }
  });
  const paths = ["**/api/deposits/quote**", "**/deposits/quote**", "**/api/ui/deposits/quote**"];
  for (const p of paths) {
    await page.route(p, async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body });
    });
  }
}

async function mockAuthGuest(page: any) {
  await page.route("**/api/auth/me", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null })
    });
  });
}

test.describe("BTC checkout", () => {
  test("desktop flow creates invoice and confirms payment", async ({ page }) => {
    await mockQuote(page, "0.015");
    await mockAuthGuest(page);

    let depositsMeCalls = 0;
    const createBody = JSON.stringify({
      request: {
        id: "dep-1",
        payment_url: "https://pay.example.com/invoice/dep-1",
        qr_code: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        status: "awaiting_payment"
      }
    });
    const createPaths = ["**/api/deposits", "**/deposits", "**/api/ui/deposits"];
    for (const p of createPaths) {
      await page.route(p, async (route: any) => {
        await route.fulfill({ status: 201, contentType: "application/json", body: createBody });
      });
    }
    const mePaths = ["**/api/deposits/me", "**/deposits/me", "**/api/ui/deposits/me"];
    for (const p of mePaths) {
      await page.route(p, async (route: any) => {
        depositsMeCalls += 1;
        const status = depositsMeCalls > 1 ? "confirmed" : "awaiting_payment";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [{ id: "dep-1", status }]
          })
        });
      });
    }

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Invest Today" })).toBeVisible();

    await fillCheckout(page);
    const investBtn = page.getByRole("button", { name: "Invest (BTC)" });
    await expect(investBtn).toBeEnabled();
    await investBtn.click();

    await expect(page.getByRole("heading", { name: "Invest Session Ready" })).toBeVisible();
    await expect(page.getByText("Status: Awaiting wallet deposit")).toBeVisible();

    await page.getByRole("button", { name: "I've Paid - Check Status" }).click();
    await expect
      .poll(
        async () => {
          const url = page.url();
          const confirmedHeading = page.getByRole("heading", { name: "Payment Confirmed" });
          const visible = await confirmedHeading.isVisible().catch(() => false);
          return visible || /\/dashboard(?:[?#]|$)/i.test(url);
        },
        { timeout: 15000 }
      )
      .toBeTruthy();
  });

  test("shows API error when deposit creation fails", async ({ page }) => {
    await mockQuote(page, "0.015");
    await mockAuthGuest(page);
    const createPaths = ["**/api/deposits", "**/deposits", "**/api/ui/deposits"];
    for (const p of createPaths) {
      await page.route(p, async (route: any) => {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not authenticated" })
        });
      });
    }

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await fillCheckout(page);
    const investBtn = page.getByRole("button", { name: "Invest (BTC)" });
    await expect(investBtn).toBeEnabled();
    await investBtn.click();
    await expect(page.getByText("Please login first to invest. Go to Portfolio, sign in, then return to Checkout.")).toBeVisible();
  });

  test("mobile layout remains usable and dashboard shortcut visible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/checkout", { waitUntil: "domcontentloaded" });

    const dashboardLinks = page.getByRole("link", { name: /Dashboard/i });
    await expect(dashboardLinks.first()).toBeVisible();

    const cards = page.locator(".checkoutCard");
    await expect(cards).toHaveCount(2);

    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect((second as any).y).toBeGreaterThan((first as any).y + (first as any).height - 4);
  });

  test("validation blocks submission without full name", async ({ page }) => {
    await mockQuote(page, "0.015");
    await mockAuthGuest(page);
    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    const investBtn = page.getByRole("button", { name: "Invest (BTC)" });
    await expect(investBtn).toBeEnabled();
    await investBtn.click();
    await expect(page.getByText("Full name is required.")).toBeVisible();
  });
});
