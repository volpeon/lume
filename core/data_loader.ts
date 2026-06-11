import { posix } from "../deps/path.ts";
import { isPlainObject } from "./utils/object.ts";

import type { Entry } from "./fs.ts";
import type Formats from "./formats.ts";

export interface Options<T> {
  /** The registered file formats */
  formats: Formats<T>;
}

/**
 * Class to load data files.
 */
export default class DataLoader<T> {
  /** List of extensions to load data files and the loader used */
  formats: Formats<T>;

  constructor(options: Options<T>) {
    this.formats = options.formats;
  }

  load(entry: Entry): Promise<Record<string, unknown> | undefined> {
    if (entry.type === "directory") {
      return this.#loadDirectory(entry);
    }

    return this.#loadFile(entry);
  }

  /** Load a _data.* file */
  async #loadFile(entry: Entry): Promise<Record<string, unknown> | undefined> {
    const format = this.formats.search(entry.path);

    if (!format?.dataLoader) {
      return;
    }

    return await entry.getContent(format.dataLoader);
  }

  /** Load a _data directory */
  async #loadDirectory(entry: Entry): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};

    for await (const child of entry.children.values()) {
      await this.loadEntry(child, data);
    }

    return data;
  }

  /**
   * Load a data entry inside a _data directory
   * and append the data to the data object
   */
  async loadEntry(entry: Entry, data: Record<string, unknown>) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
      return;
    }

    if (entry.type === "file") {
      const name = posix.basename(entry.name, posix.extname(entry.name));
      const fileData = await this.#loadFile(entry) || {};

      if (fileData.content && Object.keys(fileData).length === 1) {
        data[name] = fileData.content;
      } else {
        const target = data[name] as Record<string, unknown> | undefined;
        if (isPlainObject(fileData) || target) {
          data[name] = Object.assign(target || {}, fileData);
        } else {
          data[name] = fileData;
        }
      }

      return;
    }

    if (entry.type === "directory") {
      data[entry.name] = await this.#loadDirectory(entry);
    }
  }
}
