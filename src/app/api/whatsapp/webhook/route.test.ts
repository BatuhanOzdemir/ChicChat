import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  after: vi.fn(),
  parse: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/db/merchants", () => ({
  resolveMerchantByPhoneNumberId: async () => ({
    merchantId: "merchant",
    phoneNumberId: "123",
  }),
  primaryChannel: vi.fn(),
}));
vi.mock("@/server/whatsapp/config", () => ({
  getWhatsAppConfig: () => ({ appSecret: "configured" }),
}));
vi.mock("@/server/whatsapp/inbox", () => ({
  acceptMessages: mocks.accept,
  processInbox: vi.fn(),
}));
vi.mock("@/lib/whatsapp", () => ({
  parseInbound: mocks.parse,
  verifySignature: () => true,
  verifyWebhookChallenge: vi.fn(),
}));
vi.mock("@/server/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { POST } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockReturnValue([
    { phoneNumberId: "123", from: "905550001234", messageId: "message-1" },
  ]);
});
const request = () =>
  new Request("https://test/api/whatsapp/webhook", {
    method: "POST",
    body: "{}",
  });

it("does not acknowledge before durable acceptance completes", async () => {
  let accept!: () => void;
  mocks.accept.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  let completed = false;
  const result = POST(request()).then((response) => {
    completed = true;
    return response;
  });
  await vi.waitFor(() => expect(mocks.accept).toHaveBeenCalled());
  expect(completed).toBe(false);
  expect(mocks.after).not.toHaveBeenCalled();
  accept();
  expect((await result).status).toBe(200);
  expect(mocks.after).toHaveBeenCalledTimes(1);
});

it("requests redelivery when the durable inbox cannot accept work", async () => {
  mocks.accept.mockRejectedValue(new Error("database offline"));
  expect((await POST(request())).status).toBe(503);
  expect(mocks.after).not.toHaveBeenCalled();
});
