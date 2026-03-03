import { expect, test } from "@playwright/test";

async function fillCheckout(page: any) {
  await page.getByLabel("Full Name").fill("Mary Trader");
  await page.getByLabel("Email Address").fill("mary@example.com");
  await page.getByLabel("Street Address").fill("1 Apple Park Way");
  await page.getByLabel("City").fill("Cupertino");
  await page.getByLabel("ZIP Code").fill("95014");
  await page.getByLabel("BTC Amount").fill("0.015");
}

test.describe("BTC checkout", () => {
  test("desktop flow creates invoice and confirms payment", async ({ page }) => {
    let depositsMeCalls = 0;
    await page.route("**/api/deposits", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          request: {
            id: "dep-1",
            payment_url: "https://pay.example.com/invoice/dep-1",
            qr_code: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            status: "awaiting_payment"
          }
        })
      });
    });
    await page.route("**/api/deposits/me", async (route) => {
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

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Complete Your Purchase" })).toBeVisible();

    await fillCheckout(page);
    await page.getByRole("button", { name: "Create BTC Invoice" }).click();

    await expect(page.getByRole("heading", { name: "BTC Invoice Ready" })).toBeVisible();
    await expect(page.getByText("Status: Awaiting BTC payment")).toBeVisible();

    await page.getByRole("button", { name: "I've Paid - Check Status" }).click();
    await page.getByRole("button", { name: "I've Paid - Check Status" }).click();

    await expect(page.getByRole("heading", { name: "Payment Confirmed" })).toBeVisible();
  });

  test("shows API error when deposit creation fails", async ({ page }) => {
    await page.route("**/api/deposits", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not authenticated" })
      });
    });

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await fillCheckout(page);
    await page.getByRole("button", { name: "Create BTC Invoice" }).click();
    await expect(page.getByText("Not authenticated")).toBeVisible();
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

  test("validation blocks invalid BTC amount", async ({ page }) => {
    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Full Name").fill("Mary Trader");
    await page.getByLabel("Email Address").fill("mary@example.com");
    await page.getByLabel("Street Address").fill("1 Apple Park Way");
    await page.getByLabel("City").fill("Cupertino");
    await page.getByLabel("ZIP Code").fill("95014");
    await page.getByLabel("BTC Amount").fill("0");
    await page.getByRole("button", { name: "Create BTC Invoice" }).click();
    await expect(page.getByText("Enter a valid BTC amount.")).toBeVisible();
  });
});
