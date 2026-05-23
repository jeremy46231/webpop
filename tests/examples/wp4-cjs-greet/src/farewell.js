var i18n = require('./i18n');

module.exports = function farewell(name, lang) {
  return i18n.bye(lang) + ', ' + name + '.';
};
