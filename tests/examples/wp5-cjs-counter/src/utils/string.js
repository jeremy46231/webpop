function pad(str, width, char) {
  char = char || ' ';
  str = String(str);
  while (str.length < width) str = char + str;
  return str;
}

function repeat(str, n) {
  var result = '';
  for (var i = 0; i < n; i++) result += str;
  return result;
}

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function truncate(str, maxLen, suffix) {
  suffix = suffix !== undefined ? suffix : '...';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - suffix.length) + suffix;
}

exports.pad = pad;
exports.repeat = repeat;
exports.capitalize = capitalize;
exports.truncate = truncate;
