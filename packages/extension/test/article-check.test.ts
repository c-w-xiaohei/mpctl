import { describe, expect, test } from "bun:test";
import { checkArticle } from "../src/mp/article-check";

const validFields = { title: "A title", author: "Author", summary: "Summary" };

describe("checkArticle", () => {
  test("returns stable coverage warnings for valid fields and non-empty HTML without parsing it", () => {
    expect(checkArticle(validFields, "<p></p>")).toEqual({
      errors: [],
      warnings: ["body_semantics_unchecked", "cover_unchecked", "platform_settings_unchecked"],
    });
  });

  test("treats empty and rendered-newline titles as empty", () => {
    expect(checkArticle({ ...validFields, title: "  \n\t  " }, "body").errors).toContain(
      "title_empty",
    );
  });

  test("applies local UTF-16, single-line, and NUL limits", () => {
    expect(checkArticle({ ...validFields, title: "🌱".repeat(33) }, "body").errors).toContain(
      "title_invalid",
    );
    expect(checkArticle({ ...validFields, title: "A\nB" }, "body").errors).toContain(
      "title_invalid",
    );
    expect(checkArticle({ ...validFields, title: "A\0B" }, "body").errors).toContain(
      "title_invalid",
    );
    expect(checkArticle({ ...validFields, author: "🌱".repeat(5) }, "body").errors).toContain(
      "author_invalid",
    );
    expect(checkArticle({ ...validFields, author: "A\nB" }, "body").errors).toContain(
      "author_invalid",
    );
    expect(checkArticle({ ...validFields, author: "A\0B" }, "body").errors).toContain(
      "author_invalid",
    );
    expect(checkArticle({ ...validFields, summary: "x".repeat(121) }, "body").errors).toContain(
      "summary_invalid",
    );
    expect(checkArticle({ ...validFields, summary: "A\0B" }, "body").errors).toContain(
      "summary_invalid",
    );
  });

  test("uses whitespace-only HTML as the only known empty-body signal", () => {
    expect(checkArticle(validFields, " \n\t ")).toEqual({
      errors: ["body_empty"],
      warnings: ["cover_unchecked", "platform_settings_unchecked"],
    });
    expect(checkArticle(validFields, "<p><br></p>")).toEqual({
      errors: [],
      warnings: ["body_semantics_unchecked", "cover_unchecked", "platform_settings_unchecked"],
    });
  });

  test("warns when summary is empty and retains fixed coverage warnings", () => {
    expect(checkArticle({ ...validFields, summary: "  " }, "")).toEqual({
      errors: ["body_empty"],
      warnings: [
        "summary_platform_default_unchecked",
        "cover_unchecked",
        "platform_settings_unchecked",
      ],
    });
  });

  test("empty settings are not assumed; check returns one warning for each unchecked area", () => {
    expect(checkArticle(validFields, "<p>Text</p>")).toEqual({
      errors: [],
      warnings: ["body_semantics_unchecked", "cover_unchecked", "platform_settings_unchecked"],
    });
  });

  test("keeps issue ordering and does not mutate the confirmed snapshot", () => {
    const fields = { title: "", author: "x\n", summary: "x\0" };
    const before = structuredClone(fields);
    expect(checkArticle(fields, "  ")).toEqual({
      errors: ["title_empty", "author_invalid", "summary_invalid", "body_empty"],
      warnings: ["cover_unchecked", "platform_settings_unchecked"],
    });
    expect(fields).toEqual(before);
  });
});
