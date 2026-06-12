import { documentToString, stringToDocument } from "./utils/dom.ts";
import binaryLoader from "./loaders/binary.ts";
import { decodeURIComponentSafe } from "./utils/path.ts";

import type { Entry } from "./fs.ts";
import { posix } from "../deps/path.ts";
import { MergeStrategy } from "./utils/merge_data.ts";
import { ProxyComponents } from "./components.ts";
import { isPlainObject } from "./utils/object.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const URL_IS_HTML = /(\/|\.x?html)$/;

/** A page of the site */
export class Page<T extends UnknownData = UnknownData> {
  /** The src info */
  src: Src;

  /** Used to save the page data */
  data: T;

  /** Whether this page comes from a copied file with site.copy() */
  isCopy = false;

  /** The page content (string or Uint8Array) */
  #content?: Content;

  /** The parsed HTML (only for HTML documents) */
  #document?: Document;

  /** Convenient way to create a page dynamically */
  static create<
    T extends UnknownData & {
      content?: Content;
      url: string;
      basename?: string;
    },
  >(
    data: T,
    src?: Partial<Src>,
  ): Page<T & { basename: string }> {
    const basename = posix.basename(data.url).replace(/\.[\w.]+$/, "");

    if (data.url.endsWith("/index.html")) {
      data.url = data.url.slice(0, -10);
    }

    const page = new Page({ ...data, basename }, src);
    page.content = data.content;

    return page;
  }

  constructor(data: T, src?: Partial<Src>) {
    this.data = data;
    this.src = { path: "", ext: "", ...src };
  }

  overwrite<U extends UnknownData>(data: U): this is Page<U> {
    Object.assign(this.data, data);
    return true;
  }

  /** Duplicate this page. */
  duplicate<U extends UnknownData>(
    index: number | undefined,
    data: U,
  ): Page<U> {
    const page = new Page<U>(data, { ...this.src });

    if (index !== undefined) {
      page.src.path += `[${index}]`;
    }

    return page;
  }

  get url() {
    return getUrl(this.data.url, this);
  }

  /** To check if the page is HTML */
  get isHTML(): boolean {
    const url = this.url;
    return !!url && URL_IS_HTML.test(url);
  }

  /** Returns the output path of this page */
  get outputPath(): string {
    const url = getUrl(this.data.url, this);
    const outputPath = url && url.endsWith("/") ? url + "index.html" : url;
    return outputPath ? decodeURIComponentSafe(outputPath) : "";
  }

  /** Returns the source path of this page */
  get sourcePath(): string {
    if (!this.src.path) {
      return "(generated)";
    }

    return this.src.entry?.path ?? this.src.path + this.src.ext;
  }

  /** The content of this page */
  set content(content: Content | undefined) {
    this.#document = undefined;
    this.#content = content instanceof Uint8Array
      ? content
      : content && content.toString();
  }

  get content(): Content | undefined {
    if (this.#document) {
      this.#content = documentToString(this.#document);
      this.#document = undefined;
    }

    return this.#content;
  }

  /** The content of this page as text */
  get text(): string {
    return this.content instanceof Uint8Array
      ? decoder.decode(this.content)
      : this.content ?? "";
  }

  set text(text: string) {
    this.content = text;
  }

  /** The content of this page as bytes */
  get bytes(): Uint8Array<ArrayBuffer> {
    return this.content instanceof Uint8Array
      ? this.content
      : encoder.encode(this.content || "") as Uint8Array<ArrayBuffer>;
  }

  set bytes(bytes: Uint8Array<ArrayBuffer>) {
    this.content = bytes;
  }

  /** The parsed HTML code from the content */
  set document(document: Document) {
    this.#content = undefined;
    this.#document = document;
  }

  get document(): Document {
    if (!this.#document) {
      this.#document = stringToDocument(this.text);
    }

    return this.#document;
  }
}

export class StaticFile<T extends UnknownData = UnknownData> {
  /** The src info */
  src: Required<Src>;

  /** Used to save the contextual data */
  data: T;

  /** Whether this file must be copied with site.copy() */
  isCopy = false;

  static create<T extends UnknownData>(
    data: T,
    src: Required<Src>,
  ): StaticFile<T> {
    const file = new StaticFile(data, src);
    return file;
  }

  constructor(data: T, src: Required<Src>) {
    this.data = data;
    this.src = src;
  }

  async toPage(): Promise<
    T extends { url: string } ? Page<T & { basename: string }> : never
  > {
    const { content } = await this.src.entry.getContent(binaryLoader);
    const data = this.data as T & { url: string };
    const page = Page.create(
      { ...data, content: content as Uint8Array<ArrayBuffer> },
      this.src,
    );
    page.isCopy = this.isCopy;
    // deno-lint-ignore no-explicit-any
    return page as any;
  }

  /** Returns the output path of this page */
  get outputPath(): string {
    const url = getUrl(this.data.url);
    return url ? decodeURIComponentSafe(url) : "";
  }

  /** Returns the source path of this page */
  get sourcePath(): string {
    if (!this.src.path) {
      return "(generated)";
    }

    return this.src.entry.path;
  }
}

/** The .src property for a Page or StaticFile */
export interface Src {
  /** The path to the file (without extension) */
  path: string;

  /** The extension of the file */
  ext: string;

  /** The original entry instance */
  entry?: Entry;
}

export type UnknownData = Record<string, unknown>;

/** The .content property for a Page */
export type Content = Uint8Array<ArrayBuffer> | string;

/** The data of a page declared initially */
export interface RawData extends UnknownData {
  /** The url of a page */
  url?:
    | string
    | false
    | ((page: Page<RawData>) => string | false);

  /** The basename of a page */
  basename?: string;

  /** Mark the page as a draft */
  draft?: boolean;

  /** The date creation of the page */
  date?: Date | string | number;

  /** To configure the rendering order of a page */
  renderOrder?: number;

  /** The raw content of a page */
  content?: unknown;

  /** The layout used to render a page */
  layout?: string;

  /** To configure a different template engine(s) to render a page */
  templateEngine?: string | string[];

  /** To configure how some data keys will be merged with the parent */
  mergedKeys?: Record<string, MergeStrategy>;
}

/** The data of a page/folder once loaded and processed */
export interface Data extends RawData {
  /** The url of a page */
  url: string;

  /** The basename of the page */
  basename: string;

  /** The date creation of the page */
  date: Date;

  /**
   * The available components
   * @see https://lume.land/docs/core/components/
   */
  comp: ProxyComponents;
}

/** Promote files to pages */
export async function filesToPages<T extends UnknownData>(
  files: StaticFile<T>[],
  pages: Page<T>[],
  filter: (file: StaticFile<T>) => boolean,
): Promise<void> {
  const toRemove = files.filter(filter);

  for (const file of toRemove) {
    pages.push(await file.toPage());
    files.splice(files.indexOf(file), 1);
  }
}

export function ensureRawData(data: UnknownData): data is RawData {
  if (
    typeof data.url !== "undefined" && typeof data.url !== "string" &&
    typeof data.url !== "function" && data.url !== false
  ) {
    return false;
  }
  if (
    typeof data.basename !== "undefined" && typeof data.basename !== "string"
  ) {
    return false;
  }
  if (typeof data.draft !== "undefined" && typeof data.draft !== "boolean") {
    return false;
  }
  if (
    typeof data.date !== "undefined" && typeof data.date !== "string" &&
    typeof data.date !== "number" && !(data.date instanceof Date)
  ) {
    return false;
  }
  if (
    typeof data.renderOrder !== "undefined" &&
    typeof data.renderOrder !== "number"
  ) {
    return false;
  }
  if (
    typeof data.layout !== "undefined" && typeof data.layout !== "string"
  ) {
    return false;
  }
  if (
    typeof data.templateEngine !== "undefined" &&
    typeof data.templateEngine !== "string" &&
    !Array.isArray(data.templateEngine)
  ) {
    return false;
  }
  if (!isPlainObject(data.mergedKeys)) {
    return false;
  }

  return true;
}

function getUrl(
  value: unknown,
  page?: Page,
): string | false | undefined {
  let url = value;
  if (typeof url === "function" && page) {
    url = url(page);
  }
  if (typeof url === "boolean" && !url) {
    return url;
  }
  if (typeof url === "string") {
    return url;
  }
  return undefined;
}
