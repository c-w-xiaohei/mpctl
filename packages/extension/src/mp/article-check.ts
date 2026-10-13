import type { ArticleCheckError, ArticleCheckResult, ArticleCheckWarning } from "@mpctl/contracts";

export type ArticleCheckFields = { title: string; author: string; summary: string };

export function checkArticle(fields: ArticleCheckFields, html: string): ArticleCheckResult {
  const errors: ArticleCheckError[] = [];
  const warnings: ArticleCheckWarning[] = [];

  if (fields.title.trim() === "") errors.push("title_empty");
  else if (fields.title.length > 64 || /[\r\n\0]/.test(fields.title)) errors.push("title_invalid");

  if (fields.author.length > 8 || /[\r\n\0]/.test(fields.author)) errors.push("author_invalid");
  if (fields.summary.length > 120 || fields.summary.includes("\0")) errors.push("summary_invalid");

  if (html.trim() === "") errors.push("body_empty");
  else warnings.push("body_semantics_unchecked");

  if (fields.summary.trim() === "") warnings.push("summary_platform_default_unchecked");
  warnings.push("cover_unchecked", "platform_settings_unchecked");

  return { errors, warnings };
}
