// Text helpers shared by the reporting package.

export const VERSION = '2.1.0';

function words(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function slugify(input, options) {
  if (typeof input !== 'string') throw new TypeError('slugify expects a string');
  const separator = options?.separator || '-';
  const maxLength = Number.isInteger(options?.maxLength) ? options.maxLength : Infinity;
  let slug = words(input).join(separator);
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    while (slug.endsWith(separator)) slug = slug.slice(0, -separator.length);
  }
  return slug;
}

export function truncate(text, max, ellipsis = '...') {
  if (!Number.isInteger(max) || max < 0) throw new RangeError('max must be a non-negative integer');
  if (text.length <= max) return text;
  if (max <= ellipsis.length) return ellipsis.slice(0, max);
  return text.slice(0, max - ellipsis.length) + ellipsis;
}

export function titleCase(input) {
  return words(input)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export const kebabCase = (input) => words(input).join('-');

export const snakeCase = (input) => words(input).join('_');
