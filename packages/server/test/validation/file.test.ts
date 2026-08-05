import { describe, expect, test } from "bun:test";
import { v, ValidationError, type FileId } from "@ackerdb/server";
import { argsJsonSchema } from "../../src/validation/json-schema.ts";
import { compileStandardJsonCodec } from "../../src/validation/standard-schema.ts";

describe("File validator", () => {
  test("validates a branded signed 64-bit File identity", () => {
    const id: FileId = v.file().check(7n, "file");

    expect(id).toBe(7n as FileId);
    expect(() => v.file().check("7", "file")).toThrow(ValidationError);
    expect(() => v.file().check(2n ** 63n, "file")).toThrow("64-bit");
  });

  test("describes File identity distinctly while using the lossless bigint protocol", () => {
    const codec = compileStandardJsonCodec(v.file());

    expect(v.file().descriptor()).toEqual({ k: "file" });
    expect(v.file().tsType()).toBe("FileId");
    expect(v.file().nullable().descriptor()).toEqual({
      k: "nullable",
      inner: { k: "file" },
    });
    expect(argsJsonSchema({ file: v.file().nullable() }).properties.file).toEqual({
      type: ["integer", "string", "null"],
      pattern: "^(?:0|-?[1-9][0-9]*)$",
    });
    expect(codec.decode("7")).toBe(7n as FileId);
    expect(codec.encode(7n as FileId)).toBe("7");
    expect(() =>
      v.file()["~standard"].jsonSchema.input({ target: "draft-2020-12" })
    ).toThrow("standard-JSON protocol codec");
  });
});
