const url = process.env.TEST_DATABASE_URL;
if (process.env.DEVSENTINEL_ISOLATED_TESTS !== "true" || !url || new URL(url).pathname !== "/devsentinel_test") {
  throw new Error("Use pnpm test:integration. Direct integration runs are blocked to protect your development database.");
}
