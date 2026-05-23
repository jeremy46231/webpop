var i18n = require('./i18n');

module.exports = function greet(name, lang) {
  return i18n.hello(lang) + ', ' + name + '!';
};
