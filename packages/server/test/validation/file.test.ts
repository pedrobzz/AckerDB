import { describe, expect, test } from "bun:test";
import { v, ValidationError, type FileGrantId, type FileId } from "@ackerdb/server";
import { validatorJsonSchema } from "../../src/validation/json-schema.ts";

describe("File validator", () => {
  test("validates branded signed 64-bit File and File Grant identities", () => {
    const id: FileId = v.file().parse(7n, "file");
    const grantId: FileGrantId = v.fileGrant().parse(9n, "grant");

    expect(id).toBe(7n as FileId);
    expect(grantId).toBe(9n as FileGrantId);
    expect(() => v.file().parse("7", "file")).toThrow(ValidationError);
    expect(() => v.fileGrant().parse("9", "grant")).toThrow(ValidationError);
    expect(() => v.file().parse(2n ** 63n, "file")).toThrow("64-bit");
  });

  test("describes each identity distinctly while using the lossless bigint protocol", () => {
    const kinds = [
      ["file", "FileId", v.file()],
      ["fileGrant", "FileGrantId", v.fileGrant()],
    ] as const;
    for (const [k, tsType, validator] of kinds) {
      expect(validator.descriptor()).toEqual({ k });
      expect(validator.tsType()).toBe(tsType);
      expect(validator.nullable().descriptor()).toEqual({ k: "nullable", inner: { k } });
      expect(validatorJsonSchema(v.object({ id: validator.nullable() })).properties.id).toEqual({
        type: ["integer", "string", "null"],
        pattern: "^(?:0|-?[1-9][0-9]*)$",
      });
      expect(validator.decode("7")).toBe(7n as FileId);
      expect(validator.encode(7n as never)).toBe("7");
      expect(() =>
        validator["~standard"].jsonSchema.input({ target: "draft-2020-12" })
      ).toThrow("Standard JSON schema projection");
    }
  });
});
