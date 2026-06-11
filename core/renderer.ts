import { resolveInclude } from "./utils/path.ts";
import { isGenerator } from "./utils/generator.ts";
import { concurrent } from "./utils/concurrent.ts";
import { mergeData } from "./utils/merge_data.ts";
import { getBasename, getPageUrl } from "./utils/page_url.ts";
import { getPageDate } from "./utils/page_date.ts";
import { Page } from "./file.ts";
import { posix } from "../deps/path.ts";

import type { Content, RawData, UnknownData } from "./file.ts";
import type Processors from "./processors.ts";
import type Formats from "./formats.ts";
import type FS from "./fs.ts";
import type DebugBar from "./debugbar.ts";
import { ProcessedPage } from "./source.ts";

export interface Options<T extends UnknownData> {
  includes: string;
  prettyUrls: boolean;
  preprocessors: Processors<T>;
  formats: Formats<T>;
  fs: FS;
}

/**
 * The renderer is responsible for rendering the site pages
 * in the right order and using the right template engine.
 */
export default class Renderer<
  T extends RawData,
> {
  /** The default folder to include the layouts */
  includes: string;

  /** The filesystem instance used to read the layouts */
  fs: FS;

  /** To convert the urls to pretty /example.html => /example/ */
  prettyUrls: boolean;

  /** All preprocessors */
  preprocessors: Processors<T>;

  /** Available file formats */
  formats: Formats<T>;

  /** The registered helpers */
  helpers = new Map<string, [Helper, HelperOptions]>();

  constructor(options: Options<T>) {
    this.includes = options.includes;
    this.prettyUrls = options.prettyUrls;
    this.preprocessors = options.preprocessors;
    this.formats = options.formats;
    this.fs = options.fs;
  }

  /** Register a new helper used by the template engines */
  addHelper(name: string, fn: Helper<HelperThis<T>>, options: HelperOptions) {
    this.helpers.set(name, [fn, options]);

    for (const format of this.formats.entries.values()) {
      format.engines?.forEach((engine) => engine.addHelper(name, fn, options));
    }

    return this;
  }

  /** Render the provided pages */
  async renderPages(
    from: ProcessedPage<T>[],
    to: ProcessedPage<T>[],
    debugBar?: DebugBar,
  ): Promise<void> {
    const renderedPages: RenderedPage<T>[] = [];

    for (const group of this.#groupPages(from)) {
      const pages: ProcessedPage<T>[] = [];
      const generators: GeneratorPage<T>[] = [];

      // Split regular pages and generators
      for (const page of group) {
        if (isGeneratorPage(page)) {
          generators.push(page);
        } else {
          pages.push(page);
        }
      }

      // Preprocess the pages and add them to site.pages
      await this.preprocessors.run(pages, debugBar);
      to.push(...pages);

      debugBar?.startMeasure("generators");
      const generatedPages: ProcessedPage<T>[] = [];
      for (const page of generators) {
        const data = { ...page.data };
        const { content } = data;
        delete data.content;

        const generator = await this.render(
          content,
          data,
          page.src.path + page.src.ext,
        ) as
          | Generator<Record<string, unknown>>
          | AsyncGenerator<Record<string, unknown>>;

        let index = 0;
        const basePath = posix.dirname(page.data.url);

        for await (const data of generator) {
          if (!data.content) {
            data.content = undefined;
          }
          const newData = mergeData(page.data, data);
          const newPage = page.duplicate(index++, newData);

          let base = basePath;

          if (data.url === false) {
            continue;
          }

          if (!data.url && data.basename !== undefined) {
            // @ts-ignore: The url is added later
            delete newPage.data.url;
            base = posix.dirname(page.outputPath);
          }

          const url = getPageUrl(newPage, this.prettyUrls, base);

          if (!url) {
            continue;
          }

          newPage.data.url = url;
          newPage.data.basename = getBasename(url);
          newPage.data.date = getPageDate(newPage);

          // Prevent running the layout if the page is not HTML
          if (!data.layout && !newPage.isHTML) {
            delete newPage.data.layout;
          }
          generatedPages.push(newPage);
        }
      }
      debugBar?.endMeasure(
        "generators",
        `[Generators] Created ${generatedPages.length} pages`,
      );

      // Preprocess the generators and add them to site.pages
      await this.preprocessors.run(generatedPages, debugBar);
      to.push(...generatedPages);

      // Render the pages content
      debugBar?.startMeasure("render");
      await concurrent(
        pages.concat(generatedPages),
        async (page) => {
          try {
            const content = await this.#renderPage(page);

            // Save the children to render the layout later
            if (page.data.layout || page.isHTML) {
              if (!page.overwrite({ children: content })) {
                return;
              }
              renderedPages.push(page);
            } else {
              page.content = content;
            }
          } catch (cause) {
            throw new Error(`Error rendering the page: ${page.sourcePath}`, {
              cause,
            });
          }
        },
      );
      debugBar?.endMeasure(
        "render",
        `[Rendering] Content of ${renderedPages.length} pages`,
      );
    }

    // Render the pages layouts at the end
    debugBar?.startMeasure("render-layouts");
    await concurrent(
      renderedPages,
      async (page) => {
        try {
          page.content = await this.#renderLayout(
            page,
            page.data.children as Content,
          );
        } catch (cause) {
          throw new Error(
            `Error rendering the layout of the page ${page.sourcePath}`,
            { cause },
          );
        }
      },
    );
    debugBar?.endMeasure(
      "render-layouts",
      `[Rendering] Layouts of ${renderedPages.length} pages`,
    );
  }

  /** Render a template */
  async render(
    content: unknown,
    data: Partial<T>,
    filename: string,
    isLayout = false,
  ): Promise<unknown> {
    /** site.page({ url: "foo", content: (data) => "..." }) */
    if (
      filename === "" && !data.templateEngine && typeof content === "function"
    ) {
      data.templateEngine = "js";
    }
    const engines = this.#getEngine(filename, data, isLayout);

    if (engines) {
      for (const engine of engines) {
        content = await engine.render(content, data, filename);
      }
    }

    return content;
  }

  /** Group the pages by renderOrder */
  #groupPages(pages: ProcessedPage<T>[]): ProcessedPage<T>[][] {
    const renderOrder: Record<number | string, ProcessedPage<T>[]> = {};

    for (const page of pages) {
      const order = page.data.renderOrder || 0;
      renderOrder[order] = renderOrder[order] || [];
      renderOrder[order].push(page);
    }

    return Object.keys(renderOrder).sort().map((order) => renderOrder[order]!);
  }

  /** Render a page */
  async #renderPage(page: ProcessedPage<T>): Promise<Content> {
    const data = { ...page.data };
    const { content } = data;
    delete data.content;

    return await this.render(
      content,
      data,
      page.src.path + page.src.ext,
    ) as Content;
  }

  /** Render the page layout */
  async #renderLayout(
    page: ProcessedPage<T>,
    content: Content,
  ): Promise<Content> {
    let data = { ...page.data };
    let path = page.src.path + page.src.ext;
    let layout = data.layout;

    // Render the layouts recursively
    while (layout) {
      const format = this.formats.search(layout);

      if (!format || !format.loader) {
        throw new Error(`The layout format "${layout}" doesn't exist`);
      }

      const includesPath = format.engines?.[0]?.includes;

      if (!includesPath) {
        throw new Error(
          `The layout format "${layout}" doesn't support includes`,
        );
      }

      const layoutPath = resolveInclude(
        layout,
        includesPath,
        posix.dirname(path),
      );
      const entry = this.fs.entries.get(layoutPath);

      if (!entry) {
        throw new Error(`The layout file "${layoutPath}" doesn't exist`);
      }

      const layoutData = await entry.getContent(format.loader);

      delete data.layout;
      delete data.templateEngine;

      data = mergeData(
        layoutData,
        data,
        { content },
      );

      content = await this.render(
        layoutData.content,
        data,
        layoutPath,
        true,
      ) as Content;
      layout = typeof layoutData.layout === "string"
        ? layoutData.layout
        : undefined;
      path = layoutPath;
    }

    return content;
  }

  /** Get the engines assigned to an extension or configured in the data */
  #getEngine(
    path: string,
    data: Partial<T>,
    isLayout: boolean,
  ): Engine[] | undefined {
    let { templateEngine } = data;

    if (templateEngine) {
      templateEngine = Array.isArray(templateEngine)
        ? templateEngine
        : templateEngine.split(",");

      return templateEngine.reduce((engines: Engine[], name) => {
        const format = this.formats.get(`.${name.trim()}`);

        if (format?.engines) {
          return engines.concat(format.engines);
        }

        throw new Error(`The template engine "${name}" doesn't exist`);
      }, []);
    }

    const format = this.formats.search(path);

    if (isLayout || format?.isPage) {
      return format?.engines;
    }
  }
}

export type RenderedPage<T> = Page<
  ProcessedPage<T>["data"] & { children?: unknown }
>;

type GeneratorPage<T extends RawData> = ProcessedPage<
  T & {
    content?:
      | Generator<UnknownData, UnknownData>
      | AsyncGenerator<UnknownData, UnknownData>;
  }
>;

function isGeneratorPage<T extends RawData>(
  page: ProcessedPage<T>,
): page is GeneratorPage<T> {
  return isGenerator(page.data.content);
}

/** An interface used by all template engines */
export interface Engine<O = string | { toString(): string }> {
  /** The folder name of the includes */
  includes?: string;

  /** Delete a cached template */
  deleteCache(file: string): void;

  /** Render a template (used to render pages) */
  render(
    content: unknown,
    data: UnknownData,
    filename?: string,
  ): O | Promise<O>;

  /** Add a helper to the template engine */
  addHelper(
    name: string,
    fn: Helper,
    options: HelperOptions,
  ): void;
}

/** A generic helper to be used in template engines */
export interface HelperThis<T> {
  data?: T;
}

// deno-lint-ignore no-explicit-any
export type Helper<T = any> = (this: T | void, ...args: any[]) => any;

/** The options for a template helper */
export interface HelperOptions {
  /** The type of the helper (tag, filter, etc) */
  type: string;

  /** Whether the helper returns an instance or not */
  async?: boolean;

  /** Whether the helper has a body or not (used for tag types) */
  body?: boolean;
}
