'use strict';

/**
 * Legacy slug helper (pre-2019 utils). Turns a title into a URL slug.
 *
 * slugify(input, options)
 *   options.separator  string placed between words (default "-")
 *   options.maxLength  cut the slug to at most this many characters,
 *                      never ending on a separator
 */
var DEFAULT_SEPARATOR = '-';

function slugify(input, options) {
  var opts = options || {};
  var separator = opts.separator === undefined ? DEFAULT_SEPARATOR : String(opts.separator);
  var text = input === null || input === undefined ? '' : String(input);

  var words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(function (word) { return word.length > 0; });

  var slug = words.join(separator);

  if (typeof opts.maxLength === 'number' && opts.maxLength >= 0 && slug.length > opts.maxLength) {
    slug = slug.slice(0, opts.maxLength);
    while (separator && slug.slice(-separator.length) === separator) {
      slug = slug.slice(0, -separator.length);
    }
  }

  return slug;
}

module.exports = slugify;
module.exports.slugify = slugify;
