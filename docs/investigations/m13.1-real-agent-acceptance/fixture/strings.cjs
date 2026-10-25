'use strict';

// Text helpers shared by the legacy reporting service.

const SEPARATORS = { kebab: '-', snake: '_' };

function words(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function slugify(input, options) {
  if (typeof input !== 'string') throw new TypeError('slugify expects a string');
  const separator = (options && options.separator) || '-';
  const maxLength = options && Number.isInteger(options.maxLength) ? options.maxLength : Infinity;
  let slug = words(input).join(separator);
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    while (slug.endsWith(separator)) slug = slug.slice(0, -separator.length);
  }
  return slug;
}

function truncate(text, max, ellipsis) {
  const tail = ellipsis === undefined ? '...' : ellipsis;
  if (!Number.isInteger(max) || max < 0) throw new RangeError('max must be a non-negative integer');
  if (text.length <= max) return text;
  if (max <= tail.length) return tail.slice(0, max);
  return text.slice(0, max - tail.length) + tail;
}

function titleCase(input) {
  return words(input)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

// The case converters are generated, one per separator style.
function createApi() {
  const api = { slugify, truncate, titleCase };
  for (const style of Object.keys(SEPARATORS)) {
    api[`${style}Case`] = (input) => words(input).join(SEPARATORS[style]);
  }
  return api;
}

module.exports = createApi();
module.exports.VERSION = '2.1.0';
