import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  run: vi.fn(),
  parse: vi.fn(),
  setCookie: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.setCookie }),
}));
vi.mock("@/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/server/auth/current", () => ({
  currentPrincipal: mocks.principal,
  developmentAccess: () => false,
}));
vi.mock("@/server/simulator/enabled", () => ({
  isSimulatorEnabled: () => true,
}));
vi.mock("@/server/simulator/service", () => ({
  runSimulatorAction: mocks.run,
}));
vi.mock("@/lib/simulator/protocol", () => ({
  parseSimulatorRequest: mocks.parse,
}));
import { POST } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockReturnValue({ ok: true, value: { merchantId: "other" } });
});
const request = () =>
  new Request("https://test/api/simulator", { method: "POST", body: "{}" });
it("checks merchant membership independently of middleware and rejects forged tenant selection", async () => {
  mocks.principal.mockResolvedValue({ merchantIds: ["own"] });
  expect((await POST(request())).status).toBe(403);
  expect(mocks.run).not.toHaveBeenCalled();
});
it("rejects an unauthenticated request even if middleware is bypassed", async () => {
  mocks.principal.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(403);
  expect(mocks.run).not.toHaveBeenCalled();
});
it("keeps the console selection aligned with an authorized simulator merchant", async () => {
  mocks.principal.mockResolvedValue({ merchantIds: ["other"] });
  mocks.run.mockResolvedValue({ outbound: [] });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.setCookie).toHaveBeenCalledWith(
    "chicchat_merchant",
    "other",
    expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
  );
});
