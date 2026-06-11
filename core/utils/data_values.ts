import { plainText } from "../../deps/remove-markdown.ts";
import { isPlainObject } from "../../plugins/epub/mod.ts";
import { Page } from "../file.ts";

/**
 * Get the value of a page data
 * For example, if the value is "=title", it returns the value of the page data "title"
 * If the value is "$.title", it will return the value of the element with the selector ".title"
 */
export function getDataValue(
  page: Page,
  data: unknown,
  value?: unknown,
) {
  // Get the value from the page data
  if (typeof value === "string") {
    return searchValue(page, data, value);
  }

  if (typeof value === "function") {
    return value(data);
  }

  return value;
}

export function getPlainDataValue(
  page: Page,
  data: unknown,
  value?: unknown,
) {
  const val = getDataValue(page, data, value);

  if (typeof val === "string") {
    return plainText(val);
  }

  return val;
}

function searchValue(
  page: Page,
  data: unknown,
  value: string,
): unknown {
  if (!value || !isPlainObject(data)) {
    return;
  }

  if (value.startsWith("=")) {
    let key = value.slice(1);
    [key, value] = parseFallback(key);

    if (!key.includes(".")) {
      return data[key] ?? searchValue(page, data, value);
    }

    const keys = key.split(".");

    let val: unknown = data;
    for (const key of keys) {
      if (isPlainObject(val)) {
        val = val[key];
      } else {
        val = undefined;
        break;
      }
    }
    if (typeof val === "string" && val.startsWith("=")) {
      return searchValue(page, data, val);
    }
    return val ?? searchValue(page, data, value);
  }

  if (value.startsWith("$")) {
    let selector = value.slice(1);
    [selector, value] = parseFallback(selector);

    return queryCss(selector, page.document) ?? searchValue(page, data, value);
  }

  return value;
}

function parseFallback(key: string): [string, string] {
  const fallback = key.indexOf("||");

  if (fallback !== -1) {
    return [
      key.slice(0, fallback).trim(),
      key.slice(fallback + 2).trim(),
    ];
  }

  return [
    key,
    "",
  ];
}

// https://regexr.com/7qnot
const checkForAttrPattern = /^(.+)\s+(?:attr\(([\w\-]+)\))$/;

function queryCss(query: string, document?: Document) {
  const checkResult = query.match(checkForAttrPattern);

  const [hasAttr, q, name] = checkResult ?? [];
  if (hasAttr && q && name) {
    return document?.querySelector(q)?.getAttribute(name);
  }

  return document?.querySelector(query)?.innerHTML;
}
