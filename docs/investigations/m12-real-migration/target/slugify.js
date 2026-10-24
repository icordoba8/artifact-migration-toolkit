const DEFAULT_SEPARATOR = "-";

/**
 * Turns a title into a URL slug.
 *
 * @param {unknown} input text to slugify; null/undefined yield ""
 * @param {{ separator?: string, maxLength?: number }} [options]
 *   separator  placed between words (default "-")
 *   maxLength  cut the slug to at most this many characters, never ending on a separator
 */
export function slugify(input, options) {
  const opts = options || {};
  const separator = opts.separator === undefined ? DEFAULT_SEPARATOR : String(opts.separator);
  const text = input === null || input === undefined ? "" : String(input);

  let slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .join(separator);

  const { maxLength } = opts;
  if (typeof maxLength === "number" && maxLength >= 0 && slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    while (separator && slug.endsWith(separator)) {
      slug = slug.slice(0, -separator.length);
    }
  }

  return slug;
}

export default slugify;
