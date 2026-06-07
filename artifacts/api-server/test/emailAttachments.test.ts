import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Unit tests for the REAL emailAdmin.normalizeAttachments size guard. The
// sibling emailTools.test.ts fully mocks emailAdmin (to test mcpServer wiring),
// so it cannot exercise the real function — these tests import the actual module
// and only mock @workspace/db so the import graph resolves without a live DB.
// ---------------------------------------------------------------------------
mock.module("@workspace/db", {
  namedExports: {
    db: {},
    emailConfigTable: {},
    emailAllowedSendersTable: {},
    auditRecordsTable: {},
  },
});

const { normalizeAttachments, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES, EmailAdminError } =
  await import("../src/lib/emailAdmin");

/** Build an unpadded base64 string that decodes to exactly `bytes` (rounded up
 * to the nearest 3-byte group). "A" decodes to a valid byte, so "A".repeat(n)
 * with n a multiple of 4 decodes to n * 3 / 4 bytes. */
function base64OfSize(bytes: number): string {
  const groups = Math.ceil(bytes / 3);
  return "A".repeat(groups * 4);
}

describe("normalizeAttachments size guard", () => {
  it("accepts attachments within the limits", () => {
    const out = normalizeAttachments([
      { filename: "a.txt", content: base64OfSize(1024) },
      { filename: "b.txt", content: base64OfSize(2048), contentType: "text/plain" },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1].content_type, "text/plain");
  });

  it("rejects a single file over the per-file limit", () => {
    assert.throws(
      () =>
        normalizeAttachments([
          { filename: "huge.bin", content: base64OfSize(MAX_ATTACHMENT_BYTES + 1024) },
        ]),
      (err: unknown) => {
        assert.ok(err instanceof EmailAdminError);
        assert.equal((err as EmailAdminError).status, 400);
        assert.match((err as Error).message, /per-file limit/);
        return true;
      },
    );
  });

  it("rejects when the combined size exceeds the total limit", () => {
    // Three files each under the per-file cap but summing past the total cap.
    const perFile = Math.floor(MAX_ATTACHMENTS_TOTAL_BYTES / 3) + 1024;
    assert.ok(perFile < MAX_ATTACHMENT_BYTES, "test fixture must stay under per-file cap");
    assert.throws(
      () =>
        normalizeAttachments([
          { filename: "1.bin", content: base64OfSize(perFile) },
          { filename: "2.bin", content: base64OfSize(perFile) },
          { filename: "3.bin", content: base64OfSize(perFile) },
        ]),
      (err: unknown) => {
        assert.ok(err instanceof EmailAdminError);
        assert.match((err as Error).message, /combined limit/);
        return true;
      },
    );
  });
});
