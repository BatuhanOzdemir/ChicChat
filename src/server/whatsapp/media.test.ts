import { describe, expect, it, vi } from "vitest";
import { downloadPhoto } from "./media";
const config = {
  graphVersion: "v22.0",
  accessToken: "test-token",
  phoneNumberId: "123",
  verifyToken: "unused",
};

describe("private photo download", () => {
  it("retrieves metadata then stores authenticated image bytes", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ url: "https://lookaside.fbsbx.com/photo" }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      );
    const photo = await downloadPhoto(config, "123", request);
    expect(photo.content).toEqual(Buffer.from([1, 2, 3]));
    expect(photo.mimeType).toBe("image/png");
    expect(request.mock.calls[1][1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer test-token" },
    });
  });
  it("rejects metadata that would send credentials to an unrelated host", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ url: "https://facebook.com.evil.example/photo" }),
      );
    await expect(downloadPhoto(config, "123", request)).rejects.toThrow(
      "untrusted media host",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized or executable content", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ url: "https://lookaside.fbsbx.com/photo" }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        }),
      );
    await expect(downloadPhoto(config, "123", request)).rejects.toThrow(
      "exceeds",
    );
    const html = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ url: "https://lookaside.fbsbx.com/photo" }),
      )
      .mockResolvedValueOnce(
        new Response("<script/>", { headers: { "content-type": "text/html" } }),
      );
    await expect(downloadPhoto(config, "123", html)).rejects.toThrow(
      "unsupported",
    );
  });
});
